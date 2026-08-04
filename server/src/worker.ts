import "dotenv/config";
import { env } from "./config/env";
import { pool } from "./db";
import { logger } from "./logger";
import {
  pollQueue,
  processOutboxDirect,
  publishOutboxBatch,
  recoverStaleOutboxLocks,
} from "./services/outbox";
import { cleanupExpiredSessions, expireAbandonedCheckouts } from "./services/payments/maintenance";
import { processDuePayouts } from "./services/payments/payouts";
import { processDueRefunds } from "./services/payments/refunds";
import { processPendingAccountDeletions } from "./services/accountDeletion";

let stopping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  logger.info("QuickServe worker started");
  let maintenanceCounter = 0;
  while (!stopping) {
    try {
      await expireAbandonedCheckouts();
      await processDueRefunds();
      await processDuePayouts();
      await publishOutboxBatch();
      const queued = await pollQueue();
      const direct = await processOutboxDirect();
      maintenanceCounter += 1;
      if (maintenanceCounter >= 60) {
        await Promise.all([
          cleanupExpiredSessions(),
          recoverStaleOutboxLocks(),
          processPendingAccountDeletions(),
        ]);
        maintenanceCounter = 0;
      }
      if (!queued && !direct) await sleep(5_000);
    } catch (error) {
      logger.error({ err: error }, "Worker iteration failed");
      await sleep(10_000);
    }
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "QuickServe worker stopping");
  await pool.end();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

run().catch((error) => {
  logger.fatal({ err: error }, "QuickServe worker stopped unexpectedly");
  process.exit(1);
});
