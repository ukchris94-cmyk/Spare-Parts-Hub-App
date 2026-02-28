/**
 * Run schema.sql against DATABASE_URL.
 * Usage: npx ts-node src/db/migrate.ts   (or node dist/db/migrate.js after build)
 */
import { config } from "dotenv";
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";

config();

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://localhost:5432/spareparts_hub?user=postgres";

async function main() {
  // Resolve from server root so it works for both ts-node and node dist/db/migrate.js
const schemaPath = join(process.cwd(), "src", "db", "schema.sql");
  const sql = readFileSync(schemaPath, "utf-8");
  const pool = new Pool({ connectionString });
  try {
    await pool.query(sql);
    console.log("Schema applied successfully.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
