import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { candidateSchema, fitmentSchema, sourceSchema, type Candidate, type Fitment } from "./fitmentBackfill";

export const insertedSchema = z.object({
  id: z.string().startsWith("fit_backfill_"), part_id: z.string(),
  make: z.string(), model: z.string(), year: z.number(), trim: z.string().nullable(),
  created_at: z.string(), revision: z.string(),
}).strict();
export const applicabilityChangeSchema = z.object({
  before: z.null(),
  after: z.literal("vehicle"),
  revision: z.string(),
}).strict();
export const preparedSchema = z.object({
  type: z.literal("prepared"),
  source: sourceSchema,
  before: z.object({ compatibilities: z.tuple([]), applicabilityType: z.null() }).strict(),
  after: z.object({
    compatibility: insertedSchema,
    applicability: applicabilityChangeSchema,
  }).strict(),
}).strict();
export type Prepared = z.infer<typeof preparedSchema>;
type Client = Pick<PoolClient, "query">;

export async function applyCandidate(
  client: Client, candidate: Candidate, approvedFitment: Fitment, writeAhead: (entry: Prepared) => void,
): Promise<"applied" | "changed-or-deleted" | "already-has-fitment" | "already-classified"> {
  candidateSchema.parse(candidate);
  fitmentSchema.parse(approvedFitment);
  if (candidate.status !== "candidate" || !candidate.proposal
      || candidate.source.applicabilityType !== null
      || candidate.proposal.make !== approvedFitment.make
      || candidate.proposal.model !== approvedFitment.model
      || candidate.proposal.year !== approvedFitment.year) throw new Error("Approval does not match proposal");
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    const locked = await client.query<{
      id: string;
      name: string;
      description: string | null;
      userId: string | null;
      category: string | null;
      applicabilityType: string | null;
    }>(
      `SELECT id, name, description, user_id AS "userId", category,
         applicability_type AS "applicabilityType"
       FROM parts WHERE id = $1 FOR UPDATE`,
      [candidate.source.id],
    );
    const current = locked.rows[0];
    if (!current || current.name !== candidate.source.name
        || current.description !== candidate.source.description
        || current.userId !== candidate.source.userId
        || current.category !== candidate.source.category) {
      await client.query("ROLLBACK");
      return "changed-or-deleted";
    }
    if (current.applicabilityType !== null) {
      await client.query("ROLLBACK");
      return "already-classified";
    }
    const existing = await client.query("SELECT id FROM part_compatibilities WHERE part_id = $1", [current.id]);
    if (existing.rows.length) {
      await client.query("ROLLBACK");
      return "already-has-fitment";
    }
    const f = approvedFitment;
    const inserted = await client.query(
      "INSERT INTO part_compatibilities (id, part_id, make, model, year, trim) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, part_id, make, model, year, trim, created_at::text, xmin::text AS revision",
      ["fit_backfill_" + randomUUID(), current.id, f.make, f.model, f.year, f.trim],
    );
    const classified = await client.query(
      "UPDATE parts SET applicability_type='vehicle' WHERE id=$1 AND applicability_type IS NULL RETURNING xmin::text AS revision",
      [current.id],
    );
    if (classified.rowCount !== 1) throw new Error("Listing applicability changed during apply");
    // Fsync the complete receipt before commit, so an interrupted run remains reversible.
    writeAhead({
      type: "prepared",
      source: candidate.source,
      before: { compatibilities: [], applicabilityType: null },
      after: {
        compatibility: insertedSchema.parse(inserted.rows[0]),
        applicability: { before: null, after: "vehicle", revision: String(classified.rows[0].revision) },
      },
    });
    await client.query("COMMIT");
    return "applied";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function rollbackCandidate(client: Client, receipt: Prepared): Promise<"removed" | "unchanged-check-failed"> {
  preparedSchema.parse(receipt);
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    const f = receipt.after.compatibility;
    const part = await client.query<{ applicability_type: string | null; revision: string }>(
      "SELECT applicability_type, xmin::text AS revision FROM parts WHERE id = $1 FOR UPDATE",
      [f.part_id],
    );
    const current = part.rows[0];
    const fitments = await client.query<{ id: string }>(
      "SELECT id FROM part_compatibilities WHERE part_id=$1 FOR UPDATE",
      [f.part_id],
    );
    if (!current || current.applicability_type !== "vehicle"
        || current.revision !== receipt.after.applicability.revision
        || fitments.rows.length !== 1 || fitments.rows[0].id !== f.id) {
      await client.query("ROLLBACK");
      return "unchanged-check-failed";
    }
    const result = await client.query(
      "DELETE FROM part_compatibilities WHERE id=$1 AND part_id=$2 AND make=$3 AND model=$4 AND year=$5 AND trim IS NOT DISTINCT FROM $6 AND created_at::text=$7 AND xmin::text=$8 RETURNING id",
      [f.id, f.part_id, f.make, f.model, f.year, f.trim, f.created_at, f.revision],
    );
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return "unchanged-check-failed";
    }
    const reset = await client.query(
      "UPDATE parts SET applicability_type=NULL WHERE id=$1 AND applicability_type='vehicle' AND xmin::text=$2 RETURNING id",
      [f.part_id, receipt.after.applicability.revision],
    );
    if (reset.rowCount !== 1) {
      await client.query("ROLLBACK");
      return "unchanged-check-failed";
    }
    await client.query("COMMIT");
    return "removed";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
