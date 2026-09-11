import "dotenv/config";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { approvalSchema, catalogSchema, proposeFitment, reportSchema, sha256, type Source } from "../services/fitmentBackfill";
import { applyCandidate, preparedSchema, rollbackCandidate } from "../services/fitmentBackfillDb";
import type { PoolClient } from "pg";

function durableWriter(path: string) {
  const fd = openSync(path, "wx", 0o600);
  return {
    write(value: unknown) {
      const buffer = Buffer.from(JSON.stringify(value) + "\n");
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
      fsyncSync(fd);
    },
    close() { closeSync(fd); },
  };
}
function durableTextFile(path: string, value: string) {
  const fd = openSync(path, "wx", 0o600);
  try {
    const buffer = Buffer.from(value);
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}
function reportCsv(report: z.infer<typeof reportSchema>): string {
  const header = [
    "listing_id", "vendor_id", "vendor_name", "name", "stored_category", "status",
    "description", "proposed_make", "proposed_model", "proposed_year", "evidence",
    "trim_confirmation_required", "advisory_specifications", "reason",
  ];
  const rows = report.entries.map((entry) => [
    entry.source.id,
    entry.source.userId,
    entry.source.vendorName,
    entry.source.name,
    entry.source.category,
    entry.status,
    entry.source.description,
    entry.proposal?.make,
    entry.proposal?.model,
    entry.proposal?.year,
    entry.evidence,
    entry.requiresTrimConfirmation,
    entry.advisorySpecifications.map((item) => `${item.label}: ${item.value} [${item.evidence}]`).join("; "),
    entry.reason,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}
function required(value: string | undefined, name: string): string {
  if (!value) throw new Error("Missing --" + name);
  return value;
}
async function databaseIdentity(client: PoolClient): Promise<string> {
  const result = await client.query("SELECT current_database() AS name, oid::text, inet_server_addr()::text AS host, inet_server_port() AS port FROM pg_database WHERE datname = current_database()");
  return sha256(JSON.stringify(result.rows[0]));
}

export async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      catalog: { type: "string" }, out: { type: "string" },
      csv: { type: "string" },
      report: { type: "string" }, approval: { type: "string" }, journal: { type: "string" },
      "confirm-database": { type: "string" }, execute: { type: "boolean", default: false },
    },
  });
  const mode = positionals[0];
  if (positionals.length !== 1 || !["audit", "apply", "rollback"].includes(mode)) {
    throw new Error("Usage: fitment-backfill audit|apply|rollback (see docs/fitment-repair.md)");
  }
  const outputPath = required(values.out, "out");
  if (mode !== "audit" && !values.execute) throw new Error("Mutation requires --execute");
  // Load the application connection only after validating the operation.
  const { pool } = await import("../db");
  let client: PoolClient | undefined;
  let output: ReturnType<typeof durableWriter> | undefined;
  try {
    client = await pool.connect();
    const database = await databaseIdentity(client);
    if (mode !== "audit" && required(values["confirm-database"], "confirm-database") !== database) {
      throw new Error("Database confirmation does not match this connection");
    }
    if (mode === "audit") {
      const catalogText = readFileSync(required(values.catalog, "catalog"), "utf8");
      const csvPath = required(values.csv, "csv");
      if (csvPath === outputPath) throw new Error("--csv and --out must use different paths");
      const catalog = catalogSchema.parse(JSON.parse(catalogText));
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await client.query<Source & { has_fitment: boolean }>(
        `SELECT p.id, p.name, p.description, p.user_id AS "userId",
           COALESCE(NULLIF(u.business_name, ''), NULLIF(u.first_name, ''), split_part(u.email, '@', 1)) AS "vendorName",
           p.category, p.applicability_type AS "applicabilityType",
           EXISTS (SELECT 1 FROM part_compatibilities pc WHERE pc.part_id=p.id) AS has_fitment
         FROM parts p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.id`,
      );
      const entries = result.rows.map(({ has_fitment, ...source }) => proposeFitment(source, catalog, has_fitment));
      await client.query("COMMIT");
      const counts = {
        candidate: entries.filter((e) => e.status === "candidate").length,
        skipped: entries.filter((e) => e.status === "skipped").length,
        alreadyComplete: entries.filter((e) => e.status === "already-complete").length,
      };
      const report = reportSchema.parse({ version: 2, database, generatedAt: new Date().toISOString(), catalogSha256: sha256(catalogText), counts, entries });
      output = durableWriter(outputPath);
      output.write(report);
      durableTextFile(csvPath, reportCsv(report));
      console.log(JSON.stringify({ database, counts, reportSha256: sha256(readFileSync(outputPath, "utf8")) }));
      return;
    }
    if (mode === "apply") {
      const reportText = readFileSync(required(values.report, "report"), "utf8");
      const report = reportSchema.parse(JSON.parse(reportText));
      const approvalText = readFileSync(required(values.approval, "approval"), "utf8");
      const approval = approvalSchema.parse(JSON.parse(approvalText));
      if (report.database !== database || approval.backup.database !== database || approval.reportSha256 !== sha256(reportText)) {
        throw new Error("Report, approval, backup attestation, or database does not match");
      }
      const backupAge = Date.now() - Date.parse(approval.backup.restoreVerifiedAt);
      if (backupAge < 0 || backupAge > 24 * 60 * 60 * 1000) throw new Error("Restore verification must be within the past 24 hours");
      if (!approval.candidates.length || new Set(approval.candidates.map((c) => c.id)).size !== approval.candidates.length) {
        throw new Error("Approval must contain unique explicit candidate IDs");
      }
      if (new Set(report.entries.map((e) => e.source.id)).size !== report.entries.length) throw new Error("Duplicate report IDs");
      const selections = approval.candidates.map((selection) => {
        const candidate = report.entries.find((e) => e.source.id === selection.id);
        if (!candidate || candidate.status !== "candidate" || !candidate.proposal) throw new Error("Approved ID is not a candidate: " + selection.id);
        if ((selection.confirmedTrim === null) !== selection.allTrimsConfirmed) {
          throw new Error("Confirm either an exact trim or all trims for " + selection.id);
        }
        return { candidate, fitment: { ...candidate.proposal, trim: selection.confirmedTrim } };
      });
      output = durableWriter(outputPath);
      output.write({ type: "header", version: 2, database, reportSha256: sha256(reportText), approvalSha256: sha256(approvalText), approval, startedAt: new Date().toISOString() });
      const counts = { applied: 0, skipped: 0, failed: 0 };
      for (const selection of selections) {
        try {
          const status = await applyCandidate(client, selection.candidate, selection.fitment, (entry) => output!.write(entry));
          counts[status === "applied" ? "applied" : "skipped"]++;
          output.write({ type: "result", id: selection.candidate.source.id, status });
        } catch (error) {
          counts.failed++;
          output.write({ type: "result", id: selection.candidate.source.id, status: "failed-or-commit-uncertain", error: error instanceof Error ? error.message : String(error) });
          // Stop on any error. Prepared receipts remain usable even if commit acknowledgement was lost.
          process.exitCode = 1;
          break;
        }
      }
      output.write({ type: "summary", ...counts, unprocessed: selections.length - counts.applied - counts.skipped - counts.failed });
      console.log(JSON.stringify(counts));
      return;
    }
    const journal = readFileSync(required(values.journal, "journal"), "utf8");
    const records: unknown[] = journal.trim().split("\n").map((line) => JSON.parse(line));
    const header = z.object({ type: z.literal("header"), version: z.literal(2), database: z.string() }).parse(records[0]);
    if (header.database !== database) throw new Error("Journal belongs to another database");
    const receipts = records.filter((record: any) => record?.type === "prepared").map((record) => preparedSchema.parse(record));
    output = durableWriter(outputPath);
    output.write({ type: "rollback-header", database, journalSha256: sha256(journal), startedAt: new Date().toISOString() });
    const counts = { removed: 0, skipped: 0, failed: 0 };
    for (const receipt of receipts) {
      try {
        const status = await rollbackCandidate(client, receipt);
        counts[status === "removed" ? "removed" : "skipped"]++;
        output.write({ type: "rollback-result", id: receipt.after.compatibility.id, status });
      } catch (error) {
        counts.failed++;
        output.write({ type: "rollback-result", id: receipt.after.compatibility.id, status: "failed", error: String(error) });
        process.exitCode = 1;
        break;
      }
    }
    output.write({ type: "summary", ...counts });
    console.log(JSON.stringify(counts));
  } finally {
    output?.close();
    client?.release();
    await pool.end();
  }
}
if (require.main === module) main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
