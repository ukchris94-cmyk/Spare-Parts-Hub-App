import { Pool, PoolClient } from "pg";
import { logger } from "../logger";

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://localhost:5432/spareparts_hub?user=postgres";

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
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
