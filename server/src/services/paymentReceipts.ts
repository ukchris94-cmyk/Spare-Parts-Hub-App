import { messagingProvider } from "./messaging";
import { withClient, query } from "../db";
import { env } from "../config/env";

type ReceiptRow = {
  payment_id: string;
  user_id: string;
  phone_e164: string | null;
  order_id: string | null;
  payment_reference: string;
  subtotal_kobo: number;
  platform_fee_kobo: number;
  tax_kobo: number;
  total_kobo: number;
  method: string | null;
  paid_at: string | null;
};

function naira(kobo: number): string {
  return `NGN ${(kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function processPaymentReceipt(paymentTransactionId: string): Promise<void> {
  // SMS is reserved for security codes. The verified payment receipt remains
  // permanently available in Order Details without exposing payment data by SMS.
  if (env.MESSAGING_PROVIDER === "aws_sms") return;
  const claimed = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await client.query<ReceiptRow>(
        `SELECT p.id AS payment_id, p.user_id, u.phone_e164, p.order_id,
                p.reference AS payment_reference,
                COALESCE(p.subtotal_kobo, p.amount_kobo) AS subtotal_kobo,
                COALESCE(p.platform_fee_kobo, 0) AS platform_fee_kobo,
                COALESCE(p.tax_kobo, 0) AS tax_kobo,
                COALESCE(p.total_kobo, p.amount_kobo) AS total_kobo,
                p.method, p.paid_at
         FROM payment_transactions p
         JOIN users u ON u.id = p.user_id
         WHERE p.id = $1 AND p.status = 'paid' AND p.order_id IS NOT NULL
           AND u.phone_verified_at IS NOT NULL
           AND u.whatsapp_transaction_consent_at IS NOT NULL
         FOR UPDATE OF p, u`,
        [paymentTransactionId]
      );
      const row = result.rows[0];
      if (!row?.phone_e164) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `INSERT INTO payment_receipt_deliveries
           (payment_transaction_id, user_id, provider, status)
         VALUES ($1, $2, 'termii', 'pending')
         ON CONFLICT (payment_transaction_id) DO NOTHING`,
        [row.payment_id, row.user_id]
      );
      const delivery = await client.query<{ status: string; attempt_count: number }>(
        "SELECT status, attempt_count FROM payment_receipt_deliveries WHERE payment_transaction_id = $1 FOR UPDATE",
        [row.payment_id]
      );
      const state = delivery.rows[0];
      if (!state || ["sending", "sent", "delivered"].includes(state.status.toLowerCase()) || state.attempt_count >= 3) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `UPDATE payment_receipt_deliveries
         SET status = 'sending', attempt_count = attempt_count + 1, last_error = NULL, updated_at = NOW()
         WHERE payment_transaction_id = $1`,
        [row.payment_id]
      );
      await client.query("COMMIT");
      return row;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
  if (!claimed?.phone_e164) return;

  try {
    const sent = await messagingProvider().sendPaymentReceipt({
      phoneE164: claimed.phone_e164,
      values: {
        "1": claimed.order_id || "",
        "2": claimed.payment_reference,
        "3": naira(claimed.subtotal_kobo),
        "4": naira(claimed.platform_fee_kobo),
        "5": naira(claimed.tax_kobo),
        "6": naira(claimed.total_kobo),
        "7": claimed.method || "payment",
        "8": claimed.paid_at ? new Date(claimed.paid_at).toISOString() : new Date().toISOString(),
      },
    });
    await query(
      `UPDATE payment_receipt_deliveries
       SET provider = $2, provider_message_id = $3, status = 'sent', sent_at = NOW(), updated_at = NOW()
       WHERE payment_transaction_id = $1`,
      [claimed.payment_id, sent.provider, sent.messageId]
    );
  } catch (error) {
    await query(
      `UPDATE payment_receipt_deliveries
       SET status = 'failed', last_error = $2, updated_at = NOW()
       WHERE payment_transaction_id = $1`,
      [claimed.payment_id, error instanceof Error ? error.message.slice(0, 500) : "Receipt delivery failed"]
    );
    throw error;
  }
}
