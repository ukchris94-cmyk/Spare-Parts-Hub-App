import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { env } from "../config/env";
import { query, withClient } from "../db";
import { logger } from "../logger";
import { processDuePayouts } from "./payments/payouts";
import { processRefund } from "./payments/refunds";
import { processMonnifyWebhookEvent } from "../routes/payments";
import { ProviderWebhook } from "./payments";

type OutboxRow = {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
};

let client: SQSClient | undefined;

function queueUrl(): string | null {
  return process.env.JOBS_QUEUE_URL?.trim() || null;
}

function sqs(): SQSClient {
  if (!client) client = new SQSClient({ region: env.AWS_REGION });
  return client;
}

export async function recoverStaleOutboxLocks(): Promise<number> {
  const result = await query(
    `UPDATE outbox_events
     SET status = 'failed', locked_at = NULL,
         last_error = COALESCE(last_error, 'Worker lock expired'),
         available_at = NOW()
     WHERE status = 'processing'
       AND locked_at < NOW() - INTERVAL '15 minutes'`
  );
  return result.rowCount;
}

async function handleEvent(event: OutboxRow): Promise<void> {
  if (event.event_type === "payment.monnify_webhook") {
    await processMonnifyWebhookEvent(event.payload as unknown as ProviderWebhook, logger);
    return;
  }
  if (event.event_type === "payment.refund_requested") {
    const refundId = typeof event.payload.refundId === "string" ? event.payload.refundId : "";
    if (refundId) await processRefund(refundId);
    return;
  }
  if (event.event_type === "payout.hold_created") {
    await processDuePayouts(10);
    return;
  }
  if (event.event_type === "order.created") {
    return;
  }
  throw new Error(`Unsupported outbox event type: ${event.event_type}`);
}

async function claimPending(limit: number): Promise<OutboxRow[]> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await client.query<OutboxRow>(
        `SELECT id, event_type, payload
         FROM outbox_events
         WHERE status IN ('pending', 'failed') AND available_at <= NOW() AND attempts < 10
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [limit]
      );
      if (result.rows.length) {
        await client.query(
          `UPDATE outbox_events
           SET status = 'processing', locked_at = NOW(), attempts = attempts + 1
           WHERE id = ANY($1::text[])`,
          [result.rows.map((row) => row.id)]
        );
      }
      await client.query("COMMIT");
      return result.rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function publishOutboxBatch(limit = 10): Promise<number> {
  const url = queueUrl();
  if (!url) return 0;
  const events = await claimPending(limit);
  for (const event of events) {
    try {
      const result = await sqs().send(
        new SendMessageCommand({
          QueueUrl: url,
          MessageBody: JSON.stringify(event),
        })
      );
      await query(
        "UPDATE outbox_events SET status = 'published', queue_message_id = $2, locked_at = NULL WHERE id = $1",
        [event.id, result.MessageId || null]
      );
    } catch (error) {
      logger.error({ err: error, eventId: event.id }, "Outbox publish failed");
      await query(
        `UPDATE outbox_events
         SET status = 'failed', last_error = $2, locked_at = NULL,
             available_at = NOW() + INTERVAL '1 minute'
         WHERE id = $1`,
        [event.id, error instanceof Error ? error.message.slice(0, 500) : "SQS publish failed"]
      );
    }
  }
  return events.length;
}

export async function processOutboxDirect(limit = 10): Promise<number> {
  if (queueUrl()) return 0;
  const events = await claimPending(limit);
  for (const event of events) {
    try {
      await handleEvent(event);
      await query(
        "UPDATE outbox_events SET status = 'processed', processed_at = NOW(), locked_at = NULL WHERE id = $1",
        [event.id]
      );
    } catch (error) {
      logger.error({ err: error, eventId: event.id }, "Outbox event processing failed");
      await query(
        `UPDATE outbox_events
         SET status = 'failed', last_error = $2, locked_at = NULL,
             available_at = NOW() + INTERVAL '1 minute'
         WHERE id = $1`,
        [event.id, error instanceof Error ? error.message.slice(0, 500) : "Event processing failed"]
      );
    }
  }
  return events.length;
}

export async function pollQueue(): Promise<number> {
  const url = queueUrl();
  if (!url) return 0;
  const result = await sqs().send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 10,
      VisibilityTimeout: 60,
    })
  );
  for (const message of result.Messages || []) {
    if (!message.Body || !message.ReceiptHandle) continue;
    try {
      const event = JSON.parse(message.Body) as OutboxRow;
      await handleEvent(event);
      await query(
        "UPDATE outbox_events SET status = 'processed', processed_at = NOW(), locked_at = NULL WHERE id = $1",
        [event.id]
      );
      await sqs().send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
    } catch (error) {
      logger.error({ err: error, messageId: message.MessageId }, "Queued job processing failed");
    }
  }
  return result.Messages?.length || 0;
}
