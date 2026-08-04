import "dotenv/config";
import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";

const MIGRATION_LOCK_ID = 713_270_041;

function requiredDatabaseUrl(): string {
  const configured = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_MIGRATION_URL or DATABASE_URL is required for production migrations");
  }
  return "postgresql://localhost:5432/spareparts_hub?user=postgres";
}

function databaseSslEnabled(): boolean {
  if (process.env.DATABASE_SSL === "true") return true;
  if (process.env.DATABASE_SSL === "false") return false;
  return process.env.NODE_ENV === "production";
}

function runtimeRole(): string | null {
  const role = process.env.DATABASE_RUNTIME_ROLE?.trim();
  if (!role) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role)) {
    throw new Error("DATABASE_RUNTIME_ROLE must be a valid PostgreSQL role name");
  }
  return role;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const connectionString = requiredDatabaseUrl();
  const databaseConfig = {
    connectionString,
    ...(databaseSslEnabled()
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(process.env.DATABASE_CA_BASE64
              ? { ca: Buffer.from(process.env.DATABASE_CA_BASE64, "base64").toString("utf8") }
              : {}),
          },
        }
      : {}),
  };
  const pool = new Pool(databaseConfig);

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    const dbRoot = join(process.cwd(), "src", "db");
    const schemaSql = readFileSync(join(dbRoot, "schema.sql"), "utf8");

    await client.query("BEGIN");
    await client.query(schemaSql);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query("COMMIT");

    const migrationDir = join(dbRoot, "migrations");
    const migrations = readdirSync(migrationDir)
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();

    for (const version of migrations) {
      const sql = readFileSync(join(migrationDir, version), "utf8");
      const sqlChecksum = checksum(sql);
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [version]
      );

      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== sqlChecksum) {
          throw new Error(`Migration ${version} was changed after it was applied`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [version, sqlChecksum]
        );
        await client.query("COMMIT");
        console.log(`Applied migration ${version}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    const role = runtimeRole();
    if (role) {
      const quotedRole = quoteIdentifier(role);
      await client.query("BEGIN");
      try {
        await client.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quotedRole}`
        );
        await client.query(
          `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${quotedRole}`
        );
        await client.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quotedRole}`
        );
        await client.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${quotedRole}`
        );
        await client.query("COMMIT");
        console.log(`Granted runtime database privileges to ${role}.`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    console.log("Database schema is current.");
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
