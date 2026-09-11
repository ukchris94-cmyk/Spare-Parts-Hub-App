import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyCandidate, rollbackCandidate, type Prepared } from "./fitmentBackfillDb";
import { proposeFitment } from "./fitmentBackfill";

const url = process.env.FITMENT_TEST_DATABASE_URL;
test("isolated PostgreSQL backfill rehearsal", { skip: !url, timeout: 20000 }, async (t) => {
  const parsed = new URL(url!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      || !/test/i.test(parsed.pathname)) {
    throw new Error("Only a dedicated local database with 'test' in its name is allowed");
  }
  const pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 3000 });
  const schema = "fitment_test_" + randomUUID().replace(/-/g, "");
  const client = await pool.connect();
  let other: PoolClient | undefined;
  let created = false;
  try {
    await client.query('CREATE SCHEMA "' + schema + '"');
    created = true;
    await client.query('SET search_path TO "' + schema + '"');
    await client.query("CREATE TABLE parts (id text PRIMARY KEY, name text NOT NULL, description text, user_id text, category text, applicability_type text)");
    await client.query("CREATE TABLE part_compatibilities (id text PRIMARY KEY, part_id text NOT NULL REFERENCES parts(id), make text NOT NULL, model text NOT NULL, year integer NOT NULL CHECK (year BETWEEN 1900 AND 2200), trim text, created_at timestamptz NOT NULL DEFAULT now())");
    const source = {
      id: "p1", name: "Sensor", description: "Toyota Camry 2014",
      userId: null, vendorName: null, category: null, applicabilityType: null,
    };
    const candidate = proposeFitment(source, { Toyota: ["Camry"] });
    const f = candidate.proposal!;
    await client.query("INSERT INTO parts VALUES ($1,$2,$3)", [source.id, source.name, source.description]);
    let receipt!: Prepared;
    await t.test("apply, reread, duplicate-safe rerun, and rollback", async () => {
      assert.equal(await applyCandidate(client, candidate, f, (entry) => { receipt = entry; }), "applied");
      const saved = await client.query("SELECT make, model, year, trim FROM part_compatibilities");
      assert.deepEqual(saved.rows, [f]);
      assert.equal((await client.query("SELECT applicability_type FROM parts WHERE id='p1'")).rows[0].applicability_type, "vehicle");
      assert.equal(await applyCandidate(client, candidate, f, () => assert.fail()), "already-classified");
      assert.equal(await rollbackCandidate(client, receipt), "removed");
      assert.equal((await client.query("SELECT applicability_type FROM parts WHERE id='p1'")).rows[0].applicability_type, null);
      assert.equal(await rollbackCandidate(client, receipt), "unchanged-check-failed");
    });
    await t.test("journal failure rolls back actual insertion", async () => {
      await assert.rejects(applyCandidate(client, candidate, f, () => { throw new Error("disk failure"); }));
      assert.equal((await client.query("SELECT * FROM part_compatibilities")).rowCount, 0);
    });
    await t.test("later edit prevents rollback, even if visible values are the same", async () => {
      await applyCandidate(client, candidate, f, (entry) => { receipt = entry; });
      await client.query("UPDATE part_compatibilities SET model=model WHERE id=$1", [receipt.after.compatibility.id]);
      assert.equal(await rollbackCandidate(client, receipt), "unchanged-check-failed");
      await client.query("DELETE FROM part_compatibilities");
      await client.query("UPDATE parts SET applicability_type=NULL WHERE id='p1'");
    });
    await t.test("concurrent description change is rechecked under the lock", async () => {
      other = await pool.connect();
      await other.query('SET search_path TO "' + schema + '"');
      await client.query("BEGIN");
      await client.query("UPDATE parts SET description='Toyota Hilux Latest Model' WHERE id='p1'");
      const pending = applyCandidate(other, candidate, f, () => assert.fail());
      await client.query("COMMIT");
      assert.equal(await pending, "changed-or-deleted");
      assert.equal((await client.query("SELECT * FROM part_compatibilities")).rowCount, 0);
    });
  } finally {
    if (other) { await other.query("ROLLBACK"); other.release(); }
    await client.query("ROLLBACK");
    if (created) await client.query('DROP SCHEMA "' + schema + '" CASCADE');
    client.release();
    await pool.end();
  }
});
