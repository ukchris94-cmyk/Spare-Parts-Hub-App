import "dotenv/config";
import { Pool, PoolClient, PoolConfig } from "pg";
import { logger } from "../logger";

const fallbackConnectionString =
  "postgresql://localhost:5432/spareparts_hub?user=postgres";
const rawDatabaseUrl = process.env.DATABASE_URL?.trim();
const connectionString = rawDatabaseUrl || fallbackConnectionString;

function describeDatabaseUrl(urlString: string): {
  host: string;
  database: string;
  hasPassword: boolean;
} {
  const parsed = new URL(urlString);
  return {
    host: parsed.host,
    database: parsed.pathname.replace(/^\//, ""),
    hasPassword: parsed.password.length > 0,
  };
}

const poolConfig: PoolConfig = {
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
};

try {
  const info = describeDatabaseUrl(connectionString);
  if (rawDatabaseUrl && !info.hasPassword && !process.env.PGPASSWORD) {
    logger.error(
      { host: info.host, database: info.database },
      "DATABASE_URL is set but password is missing. Add password to DATABASE_URL or set PGPASSWORD."
    );
  } else {
    logger.info(
      { host: info.host, database: info.database, hasPassword: info.hasPassword || !!process.env.PGPASSWORD },
      "Postgres configuration loaded"
    );
  }
} catch (err) {
  logger.error(
    { err, hasDatabaseUrl: !!rawDatabaseUrl },
    "Invalid DATABASE_URL format"
  );
}

export const pool = new Pool({
  ...poolConfig,
});

pool.on("error", (err: Error) => {
  logger.error({ err }, "Postgres pool error");
});

pool.on("connect", () => {
  logger.debug("Postgres pool: new client connected");
});

export async function query<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    logger.debug(
      { text: text.split(/\s+/)[0], durationMs: Date.now() - start, rows: result.rowCount },
      "db query"
    );
    return { rows: (result.rows as T[]), rowCount: result.rowCount ?? 0 };
  } catch (err) {
    logger.error({ err, text: text.substring(0, 100) }, "db query error");
    throw err;
  }
}

export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
