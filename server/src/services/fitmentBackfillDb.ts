import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { candidateSchema, fitmentSchema, sourceSchema, type Candidate, type Fitment } from "./fitmentBackfill";

export const insertedSchema = z.object({
  id: z.string().startsWith("fit_backfill_"), part_id: z.string(),
  make: z.string(), model: z.string(), year: z.number(), trim: z.string().nullable(),
  created_at: z.string(), revision: z.string(),
}).strict();
export const preparedSchema = z.object({
  type: z.literal("prepared"), source: sourceSchema, before: z.tuple([]),
  after: insertedSchema,
}).strict();
export type Prepared = z.infer<typeof preparedSchema>;
type Client = Pick<PoolClient, "query">;

export async function applyCandidate(
  client: Client, candidate: Candidate, approvedFitment: Fitment, writeAhead: (entry: Prepared) => void,
): Promise<"applied" | "changed-or-deleted" | "already-has-fitment"> {
  candidateSchema.parse(candidate);
  fitmentSchema.parse(approvedFitment);
  if (candidate.status !== "candidate" || !candidate.proposal
      || candidate.proposal.make !== approvedFitment.make
      || candidate.proposal.model !== approvedFitment.model
      || candidate.proposal.year !== approvedFitment.year) throw new Error("Approval does not match proposal");
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    const locked = await client.query(
      "SELECT id, name, description FROM parts WHERE id = $1 FOR UPDATE", [candidate.source.id],
    );
    const current = locked.rows[0];
    if (!current || current.name !== candidate.source.name || current.description !== candidate.source.description) {
      await client.query("ROLLBACK");
      return "changed-or-deleted";
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
    // Fsync the insertion receipt before commit, so an interrupted run remains reversible.
    writeAhead({ type: "prepared", source: candidate.source, before: [], after: insertedSchema.parse(inserted.rows[0]) });
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
    await client.query("SELECT id FROM parts WHERE id = $1 FOR UPDATE", [receipt.after.part_id]);
    const f = receipt.after;
    const result = await client.query(
      "DELETE FROM part_compatibilities WHERE id=$1 AND part_id=$2 AND make=$3 AND model=$4 AND year=$5 AND trim IS NOT DISTINCT FROM $6 AND created_at::text=$7 AND xmin::text=$8 RETURNING id",
      [f.id, f.part_id, f.make, f.model, f.year, f.trim, f.created_at, f.revision],
    );
    await client.query("COMMIT");
    return result.rowCount ? "removed" : "unchanged-check-failed";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
