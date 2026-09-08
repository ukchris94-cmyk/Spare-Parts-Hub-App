import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { applyCandidate, rollbackCandidate, type Prepared } from "./fitmentBackfillDb";
import { proposeFitment } from "./fitmentBackfill";

const source = { id: "part_test", name: "Sensor", description: "Toyota Camry 2014" };
const candidate = proposeFitment(source, { Toyota: ["Camry"] });
const fitment = candidate.proposal!;

function fixture(options: { changed?: boolean; exists?: boolean; touched?: boolean } = {}) {
  const commands: string[] = [];
  let inserted: any = null;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      commands.push(sql);
      if (sql.startsWith("SELECT id, name")) return { rows: [{ ...source, ...(options.changed ? { description: "changed" } : {}) }] };
      if (sql.startsWith("SELECT id FROM part_compatibilities")) return { rows: options.exists || inserted ? [{ id: "existing" }] : [] };
      if (sql.startsWith("INSERT")) {
        inserted = { id: params![0], part_id: source.id, ...fitment, created_at: "2026-09-07 12:00:00+00", revision: "123" };
        return { rows: [inserted] };
      }
      if (sql.startsWith("DELETE")) {
        const matches = inserted && !options.touched && params![0] === inserted.id && params![7] === inserted.revision;
        if (matches) inserted = null;
        return { rowCount: matches ? 1 : 0, rows: [] };
      }
      return { rows: [] };
    },
  } as unknown as Pick<PoolClient, "query">;
  return { client, commands };
}
test("apply locks parent, journals before commit, and reruns skip", async () => {
  const f = fixture();
  let receipt: Prepared | undefined;
  assert.equal(await applyCandidate(f.client, candidate, fitment, (entry) => {
    assert.ok(!f.commands.includes("COMMIT"));
    receipt = entry;
  }), "applied");
  assert.ok(f.commands.some((sql) => sql.includes("FOR UPDATE")));
  assert.ok(receipt?.after.id.startsWith("fit_backfill_"));
  assert.deepEqual(receipt?.before, []);
  assert.equal(await applyCandidate(f.client, candidate, fitment, () => assert.fail()), "already-has-fitment");
});
test("source changes and existing fitment are skipped without insertion", async () => {
  for (const options of [{ changed: true }, { exists: true }]) {
    const f = fixture(options);
    assert.notEqual(await applyCandidate(f.client, candidate, fitment, () => assert.fail()), "applied");
    assert.equal(f.commands.some((sql) => sql.startsWith("INSERT")), false);
    assert.ok(f.commands.includes("ROLLBACK"));
  }
});
test("receipt write failure rolls back and never commits", async () => {
  const f = fixture();
  await assert.rejects(applyCandidate(f.client, candidate, fitment, () => { throw new Error("disk full"); }), /disk full/);
  assert.ok(f.commands.includes("ROLLBACK"));
  assert.ok(!f.commands.includes("COMMIT"));
});
test("rollback removes only matching inserted rows and is repeatable", async () => {
  const f = fixture();
  let receipt!: Prepared;
  await applyCandidate(f.client, candidate, fitment, (entry) => { receipt = entry; });
  assert.equal(await rollbackCandidate(f.client, receipt), "removed");
  assert.equal(await rollbackCandidate(f.client, receipt), "unchanged-check-failed");
  const deletion = f.commands.find((sql) => sql.startsWith("DELETE"))!;
  for (const condition of ["part_id", "make", "model", "year", "trim IS NOT DISTINCT", "created_at", "xmin"]) {
    assert.ok(deletion.includes(condition));
  }
});
test("rollback leaves a subsequently touched fitment unchanged", async () => {
  const f = fixture({ touched: true });
  let receipt!: Prepared;
  await applyCandidate(f.client, candidate, fitment, (entry) => { receipt = entry; });
  assert.equal(await rollbackCandidate(f.client, receipt), "unchanged-check-failed");
});
test("invalid and mismatched approved proposals never start transactions", async () => {
  const f = fixture();
  await assert.rejects(applyCandidate(f.client, candidate, { ...fitment, year: 2015 }, () => assert.fail()));
  assert.equal(f.commands.length, 0);
});
