import { PoolClient } from "pg";
import { query, withClient } from "../../db";
import { logger } from "../../logger";
import { CheckoutOrderError, genCheckoutId } from "../orderCheckout";
import { getPaymentProvider } from ".";
import { ProviderRefundVerification } from "./provider";

type DbClient = Pick<PoolClient, "query">;

type RefundRow = {
  id: string;
  payment_id: string;
  order_id: string;
  provider: string;
  provider_reference: string | null;
  amount_kobo: number;
  currency: string;
  reason: string;
  status: string;
  attempt_count: number;
  reconciliation_attempt_count: number;
};

function storedRefundStatus(status: ProviderRefundVerification["status"]): string {
  if (status === "completed") return "completed";
  if (status === "failed") return "manual_review";
  return "processing";
}

export async function applyVerifiedRefund(input: {
  refundReference: string;
  verification: ProviderRefundVerification;
}): Promise<boolean> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const refundResult = await client.query<RefundRow>(
        `SELECT * FROM payment_refunds
         WHERE id = $1 OR provider_reference = $1
         FOR UPDATE`,
        [input.refundReference]
      );
      const refund = refundResult.rows[0];
      if (!refund) {
        await client.query("COMMIT");
        return false;
      }

      const referenceMatches =
        input.verification.providerReference === refund.id ||
        input.verification.providerReference === refund.provider_reference;
      const amountMatches = input.verification.amountKobo === refund.amount_kobo;
      if (!referenceMatches || !amountMatches) {
        const reason = !referenceMatches
          ? "Provider refund reference mismatch"
          : "Provider refund amount mismatch";
        await client.query(
          `UPDATE payment_refunds
           SET status = 'manual_review', last_error = $2,
               provider_response = $3::jsonb, updated_at = NOW()
           WHERE id = $1`,
          [refund.id, reason, JSON.stringify(input.verification.providerData)]
        );
        await client.query(
          `UPDATE payment_transactions
           SET refund_status = 'manual_review', updated_at = NOW()
           WHERE id = $1`,
          [refund.payment_id]
        );
        await client.query("COMMIT");
        logger.error({ refundId: refund.id, reason }, "Refund reconciliation requires manual review");
        return true;
      }

      const status = storedRefundStatus(input.verification.status);
      await client.query(
        `UPDATE payment_refunds
         SET status = $2,
             provider_reference = $3,
             provider_response = $4::jsonb,
             last_error = CASE WHEN $2 = 'manual_review' THEN 'Provider reported refund failure' ELSE NULL END,
             next_attempt_at = CASE WHEN $2 = 'processing' THEN NOW() + INTERVAL '5 minutes' ELSE next_attempt_at END,
             updated_at = NOW(),
             completed_at = CASE WHEN $2 = 'completed' THEN COALESCE(completed_at, NOW()) ELSE completed_at END
         WHERE id = $1`,
        [refund.id, status, input.verification.providerReference, JSON.stringify(input.verification.providerData)]
      );
      await client.query(
        `UPDATE payment_transactions
         SET refund_status = $2,
             refunded_amount_kobo = CASE WHEN $2 = 'completed' THEN $3 ELSE refunded_amount_kobo END,
             refunded_at = CASE WHEN $2 = 'completed' THEN COALESCE(refunded_at, NOW()) ELSE refunded_at END,
             updated_at = NOW()
         WHERE id = $1`,
        [refund.payment_id, status, refund.amount_kobo]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function reconcileRefund(refundReference: string): Promise<boolean> {
  const refundResult = await query<RefundRow>(
    `SELECT * FROM payment_refunds
     WHERE id = $1 OR provider_reference = $1
     LIMIT 1`,
    [refundReference]
  );
  const refund = refundResult.rows[0];
  if (!refund) return false;
  const verification = await getPaymentProvider(refund.provider).verifyRefund({
    refundReference: refund.id,
  });
  if (!verification) return false;
  return applyVerifiedRefund({ refundReference: refund.id, verification });
}

export async function queueFullOrderRefund(
  client: DbClient,
  input: { orderId: string; requestedBy: string; reason: string }
): Promise<{ id: string; status: string } | null> {
  const paymentResult = await client.query<{
    id: string;
    provider: string;
    provider_reference: string | null;
    total_kobo: number | null;
    amount_kobo: number;
    currency: string;
    status: string;
  }>(
    `SELECT id, provider, provider_reference, total_kobo, amount_kobo, currency, status
     FROM payment_transactions
     WHERE order_id = $1
     FOR UPDATE`,
    [input.orderId]
  );
  const payment = paymentResult.rows[0];
  if (!payment) return null;
  if (payment.status !== "paid") {
    throw new CheckoutOrderError(409, "Only a confirmed payment can be refunded.");
  }

  const refundId = genCheckoutId("ref");
  const refundResult = await client.query<{ id: string; status: string }>(
    `INSERT INTO payment_refunds
       (id, payment_id, order_id, provider, amount_kobo, currency, reason, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
     ON CONFLICT (payment_id, reason) DO UPDATE
       SET updated_at = payment_refunds.updated_at
     RETURNING id, status`,
    [
      refundId,
      payment.id,
      input.orderId,
      payment.provider || "monnify",
      payment.total_kobo ?? payment.amount_kobo,
      payment.currency,
      input.reason,
      input.requestedBy,
    ]
  );
  const refund = refundResult.rows[0];

  const inventory = await client.query<{ part_id: string; quantity: number }>(
    `UPDATE inventory_reservations
     SET status = 'refunded', released_at = NOW()
     WHERE payment_id = $1 AND status = 'consumed'
     RETURNING part_id, quantity`,
    [payment.id]
  );
  for (const item of inventory.rows) {
    await client.query("UPDATE parts SET stock_qty = stock_qty + $2 WHERE id = $1", [
      item.part_id,
      item.quantity,
    ]);
  }

  await client.query(
    `UPDATE payment_transactions
     SET refund_status = $2, refund_reference = $3, refund_reason = $4, updated_at = NOW()
     WHERE id = $1`,
    [payment.id, refund.status, refund.id, input.reason]
  );
  await client.query(
    `INSERT INTO outbox_events
       (id, event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1, 'payment.refund_requested', 'refund', $2, $3::jsonb)`,
    [genCheckoutId("evt"), refund.id, JSON.stringify({ refundId: refund.id, orderId: input.orderId })]
  );
  return refund;
}

export async function processRefund(refundId: string): Promise<void> {
  const claimed = await query<RefundRow>(
    `UPDATE payment_refunds r
     SET status = 'processing', attempt_count = attempt_count + 1, updated_at = NOW()
     WHERE r.id = $1
       AND r.status = 'pending'
       AND r.next_attempt_at <= NOW()
       AND r.attempt_count = 0
     RETURNING r.*`,
    [refundId]
  );
  const refund = claimed.rows[0];
  if (!refund) return;

  const paymentResult = await query<{ provider_reference: string | null }>(
    "SELECT provider_reference FROM payment_transactions WHERE id = $1 LIMIT 1",
    [refund.payment_id]
  );
  const transactionReference = paymentResult.rows[0]?.provider_reference;
  if (!transactionReference) {
    await markRefundForManualReview(refund, "Original provider transaction reference is missing");
    return;
  }

  try {
    const provider = getPaymentProvider(refund.provider);
    const result = await provider.refund({
      transactionReference,
      refundReference: refund.id,
      amountKobo: refund.amount_kobo,
      reason: refund.reason.replace(/_/g, " "),
    });
    await applyVerifiedRefund({ refundReference: refund.id, verification: result });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 400) : "Unknown provider response";
    logger.error({ err: error, refundId: refund.id }, "Refund requires reconciliation");
    await query(
      `UPDATE payment_refunds
       SET status = 'reconciliation_required',
           last_error = $2,
           next_attempt_at = NOW() + INTERVAL '5 minutes',
           updated_at = NOW()
       WHERE id = $1 AND status = 'processing'`,
      [refund.id, `Provider response uncertain; verify before any retry. ${message}`]
    );
    await query(
      `UPDATE payment_transactions
       SET refund_status = 'reconciliation_required', updated_at = NOW()
       WHERE id = $1`,
      [refund.payment_id]
    );
  }
}

async function markRefundForManualReview(refund: RefundRow, message: string): Promise<void> {
  await query(
    `UPDATE payment_refunds
     SET status = 'manual_review', last_error = $2, updated_at = NOW()
     WHERE id = $1`,
    [refund.id, message]
  );
  await query(
    "UPDATE payment_transactions SET refund_status = 'manual_review', updated_at = NOW() WHERE id = $1",
    [refund.payment_id]
  );
}

export async function processDueRefunds(limit = 10): Promise<number> {
  const due = await query<{ id: string }>(
    `SELECT id FROM payment_refunds
     WHERE status = 'pending' AND next_attempt_at <= NOW() AND attempt_count = 0
     ORDER BY created_at
     LIMIT $1`,
    [limit]
  );
  for (const row of due.rows) await processRefund(row.id);

  const reconciling = await query<{
    id: string;
    payment_id: string;
    reconciliation_attempt_count: number;
  }>(
    `UPDATE payment_refunds
     SET status = 'reconciliation_required',
         reconciliation_attempt_count = reconciliation_attempt_count + 1,
         next_attempt_at = NOW() + INTERVAL '5 minutes',
         updated_at = NOW()
     WHERE id IN (
       SELECT id FROM payment_refunds
       WHERE status IN ('processing', 'reconciliation_required')
         AND next_attempt_at <= NOW()
         AND reconciliation_attempt_count < 6
       ORDER BY updated_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     RETURNING id, payment_id, reconciliation_attempt_count`,
    [limit]
  );
  for (const row of reconciling.rows) {
    try {
      const found = await reconcileRefund(row.id);
      if (!found) {
        logger.warn({ refundId: row.id }, "Refund is not yet available for reconciliation");
        await markUnresolvedRefund(
          row.id,
          row.payment_id,
          row.reconciliation_attempt_count,
          "Provider refund was not available for verification"
        );
      }
    } catch (error) {
      logger.error({ err: error, refundId: row.id }, "Refund reconciliation failed");
      const message = error instanceof Error ? error.message.slice(0, 400) : "Refund verification failed";
      await markUnresolvedRefund(
        row.id,
        row.payment_id,
        row.reconciliation_attempt_count,
        message
      );
    }
  }
  return due.rowCount + reconciling.rowCount;
}

async function markUnresolvedRefund(
  refundId: string,
  paymentId: string,
  attempt: number,
  message: string
): Promise<void> {
  const exhausted = attempt >= 6;
  const status = exhausted ? "manual_review" : "reconciliation_required";
  await query(
    `UPDATE payment_refunds
     SET status = $2, last_error = $3, updated_at = NOW()
     WHERE id = $1 AND status = 'reconciliation_required'`,
    [
      refundId,
      status,
      exhausted
        ? `Automatic reconciliation exhausted; manual provider review required. ${message}`
        : `Provider status still unavailable; automatic reconciliation will continue. ${message}`,
    ]
  );
  await query(
    `UPDATE payment_transactions
     SET refund_status = $2, updated_at = NOW()
     WHERE id = $1 AND refund_status <> 'completed'`,
    [paymentId, status]
  );
}
