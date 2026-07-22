import "dotenv/config";
import { readFile, writeFile } from "fs/promises";
import { pool } from "../db";
import { geocodeAddress, type ResolvedPlace } from "../services/googleMaps";

type LegacySide = "pickup" | "dropoff";

type ReviewEntry = {
  deliveryJobId: string;
  orderId: string;
  side: LegacySide;
  sourceAddress: string;
  proposedLocation: ResolvedPlace | null;
  approved: boolean;
  error?: string;
};

type ReviewReport = {
  generatedAt: string;
  reviewBy: string;
  entries: ReviewEntry[];
};

function argumentValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

function isMappableSource(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length >= 8 &&
    !["vendor pickup", "customer dropoff", "customer drop-off"].includes(normalized) &&
    !normalized.endsWith(" pickup")
  );
}

function validProposedLocation(location: ResolvedPlace | null): location is ResolvedPlace {
  return Boolean(
    location &&
      location.formattedAddress &&
      Number.isFinite(location.latitude) &&
      location.latitude >= -90 &&
      location.latitude <= 90 &&
      Number.isFinite(location.longitude) &&
      location.longitude >= -180 &&
      location.longitude <= 180
  );
}

async function createReport(path: string): Promise<void> {
  const result = await pool.query<{
    id: string;
    order_id: string;
    pickup_address: string | null;
    pickup_latitude: number | null;
    pickup_longitude: number | null;
    dropoff_address: string | null;
    dropoff_latitude: number | null;
    dropoff_longitude: number | null;
  }>(
    `SELECT
       id,
       order_id,
       COALESCE(NULLIF(pickup_formatted_address, ''), NULLIF(pickup_details, '')) AS pickup_address,
       pickup_latitude,
       pickup_longitude,
       COALESCE(NULLIF(dropoff_formatted_address, ''), NULLIF(dropoff_details, '')) AS dropoff_address,
       dropoff_latitude,
       dropoff_longitude
     FROM delivery_jobs
     WHERE (pickup_latitude IS NULL OR pickup_longitude IS NULL)
        OR (dropoff_latitude IS NULL OR dropoff_longitude IS NULL)
     ORDER BY created_at ASC`,
  );

  const candidates: Omit<ReviewEntry, "proposedLocation" | "approved">[] = [];
  for (const row of result.rows) {
    if (
      (row.pickup_latitude === null || row.pickup_longitude === null) &&
      row.pickup_address &&
      isMappableSource(row.pickup_address)
    ) {
      candidates.push({
        deliveryJobId: row.id,
        orderId: row.order_id,
        side: "pickup",
        sourceAddress: row.pickup_address,
      });
    }
    if (
      (row.dropoff_latitude === null || row.dropoff_longitude === null) &&
      row.dropoff_address &&
      isMappableSource(row.dropoff_address)
    ) {
      candidates.push({
        deliveryJobId: row.id,
        orderId: row.order_id,
        side: "dropoff",
        sourceAddress: row.dropoff_address,
      });
    }
  }

  const cache = new Map<string, ResolvedPlace>();
  const entries: ReviewEntry[] = [];
  for (const candidate of candidates) {
    try {
      let proposedLocation = cache.get(candidate.sourceAddress);
      if (!proposedLocation) {
        proposedLocation = await geocodeAddress(candidate.sourceAddress);
        cache.set(candidate.sourceAddress, proposedLocation);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      entries.push({ ...candidate, proposedLocation, approved: false });
    } catch (error) {
      entries.push({
        ...candidate,
        proposedLocation: null,
        approved: false,
        error: error instanceof Error ? error.message : "Geocoding failed",
      });
    }
  }

  const generatedAt = new Date();
  const report: ReviewReport = {
    generatedAt: generatedAt.toISOString(),
    reviewBy: new Date(generatedAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    entries,
  };
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Wrote ${entries.length} review entries to ${path}. No database rows were changed.`);
}

async function applyReport(path: string): Promise<void> {
  const report = JSON.parse(await readFile(path, "utf8")) as ReviewReport;
  if (!Array.isArray(report.entries)) throw new Error("Invalid review report");

  const client = await pool.connect();
  let updated = 0;
  let skipped = 0;
  try {
    await client.query("BEGIN");
    for (const entry of report.entries) {
      if (!entry.approved || !validProposedLocation(entry.proposedLocation)) {
        skipped += 1;
        continue;
      }
      const prefix = entry.side === "pickup" ? "pickup" : "dropoff";
      const result = await client.query(
        `UPDATE delivery_jobs
         SET ${prefix}_formatted_address = COALESCE(NULLIF(${prefix}_formatted_address, ''), $1),
             ${prefix}_latitude = $2,
             ${prefix}_longitude = $3,
             ${prefix}_place_id = COALESCE(${prefix}_place_id, $4),
             updated_at = NOW()
         WHERE id = $5
           AND order_id = $6
           AND (${prefix}_latitude IS NULL OR ${prefix}_longitude IS NULL)
           AND COALESCE(NULLIF(${prefix}_formatted_address, ''), NULLIF(${prefix}_details, '')) = $7`,
        [
          entry.proposedLocation.formattedAddress,
          entry.proposedLocation.latitude,
          entry.proposedLocation.longitude,
          entry.proposedLocation.placeId,
          entry.deliveryJobId,
          entry.orderId,
          entry.sourceAddress,
        ],
      );
      if (result.rowCount === 1) updated += 1;
      else skipped += 1;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  console.log(`Applied ${updated} approved entries; skipped ${skipped}.`);
}

async function main(): Promise<void> {
  const reportPath = argumentValue("--report");
  const applyPath = argumentValue("--apply");
  if (reportPath && !applyPath) await createReport(reportPath);
  else if (applyPath && !reportPath) await applyReport(applyPath);
  else {
    throw new Error("Use exactly one mode: --report <path> or --apply <reviewed-path>");
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
