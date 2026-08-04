import "dotenv/config";
import { Pool, PoolClient } from "pg";

const ROLE_BOOTSTRAP_LOCK_ID = 713_270_042;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error("MASTER_DB_NAME must be a valid PostgreSQL identifier");
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function upsertLoginRole(client: PoolClient, role: string, password: string) {
  if (password.length < 32) throw new Error(`${role} password must be at least 32 characters`);
  const exists = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [role]
  );
  const statement = exists.rows[0].exists
    ? "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1, $2) AS sql"
    : "SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L', $1, $2) AS sql";
  const formatted = await client.query<{ sql: string }>(statement, [role, password]);
  await client.query(formatted.rows[0].sql);
}

async function main() {
  const host = required("MASTER_DB_HOST");
  const user = required("MASTER_DB_USERNAME");
  const password = required("MASTER_DB_PASSWORD");
  const database = process.env.MASTER_DB_NAME?.trim() || "quickserve";
  const quotedDatabase = quoteIdentifier(database);
  const port = Number(process.env.MASTER_DB_PORT || "5432");
  const ca = required("DATABASE_CA_BASE64");

  const pool = new Pool({
    host,
    user,
    password,
    database,
    port,
    ssl: {
      rejectUnauthorized: true,
      ca: Buffer.from(ca, "base64").toString("utf8"),
    },
  });
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [ROLE_BOOTSTRAP_LOCK_ID]);
    await client.query("BEGIN");
    await upsertLoginRole(client, "quickserve_migrator", required("MIGRATION_DB_PASSWORD"));
    await upsertLoginRole(client, "quickserve_runtime", required("RUNTIME_DB_PASSWORD"));
    await client.query(`GRANT CONNECT ON DATABASE ${quotedDatabase} TO quickserve_migrator`);
    await client.query(`GRANT CONNECT ON DATABASE ${quotedDatabase} TO quickserve_runtime`);
    await client.query("GRANT USAGE, CREATE ON SCHEMA public TO quickserve_migrator");
    await client.query("GRANT USAGE ON SCHEMA public TO quickserve_runtime");
    await client.query("COMMIT");
    console.log("Database roles are configured.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ROLE_BOOTSTRAP_LOCK_ID]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Database role bootstrap failed");
  process.exit(1);
});
