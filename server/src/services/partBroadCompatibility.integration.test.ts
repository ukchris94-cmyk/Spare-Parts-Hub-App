import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";

const url = process.env.FITMENT_TEST_DATABASE_URL;

test("broad compatibility migration preserves unresolved and pending listings", { skip: !url, timeout: 20000 }, async () => {
  const parsed = new URL(url!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test/i.test(parsed.pathname)) {
    throw new Error("Only a dedicated local database with 'test' in its name is allowed");
  }
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000 });
  const client = await pool.connect();
  const schema = `broad_test_${randomUUID().replace(/-/g, "")}`;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("CREATE TABLE parts (id text PRIMARY KEY, applicability_type text, listing_status text NOT NULL)");
    await client.query(`INSERT INTO parts VALUES
      ('published-universal', 'universal', 'published'),
      ('pending-universal', 'universal', 'pending_review'),
      ('unresolved', NULL, 'published')`);
    const migration = await readFile(join(process.cwd(), "src", "db", "migrations", "015_part_broad_compatibility.sql"), "utf8");
    await client.query(migration);

    const rows = await client.query("SELECT * FROM parts ORDER BY id");
    const published = rows.rows.find((row) => row.id === "published-universal");
    assert.equal(published.broad_compatibility_scope, "all_makes");
    assert.equal(published.broad_year_scope, "all_years");
    assert.deepEqual(published.broad_vehicle_makes, []);
    for (const id of ["pending-universal", "unresolved"]) {
      const row = rows.rows.find((entry) => entry.id === id);
      assert.equal(row.broad_compatibility_scope, null);
      assert.equal(row.broad_year_scope, null);
    }

    await assert.rejects(client.query(
      "UPDATE parts SET broad_compatibility_scope='all_makes', broad_vehicle_makes=ARRAY['Toyota'], broad_year_scope='all_years' WHERE id='unresolved'",
    ));
  } finally {
    await client.query("ROLLBACK");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  }
});
