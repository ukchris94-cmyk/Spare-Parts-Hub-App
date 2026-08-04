import { PoolClient } from "pg";
import { query, withClient } from "../../db";
import { logger } from "../../logger";
import { decryptPayoutAccountNumber, encryptPayoutAccountNumber } from "../secureData";
import { CheckoutOrderError, genCheckoutId } from "../orderCheckout";
import { getPaymentProvider } from ".";
import { ProviderPayoutVerification } from "./provider";

type DbClient = Pick<PoolClient, "query">;

function payoutHoldHours(): number {
  const configured = Number.parseInt(process.env.PAYOUT_HOLD_HOURS || "24", 10);
  return Number.isFinite(configured) ? Math.min(720, Math.max(0, configured)) : 24;
}

export async function createVendorPayoutHold(
  client: DbClient,
  input: { orderId: string; vendorId: string }
): Promise<{ id: string; amountKobo: number } | null> {
  const result = await client.query<{
    items: unknown;
    payment_id: string | null;
    payment_status: string | null;
  }>(
    `SELECT o.items, p.id AS payment_id, p.status AS payment_status
     FROM orders o
     LEFT JOIN payment_transactions p ON p.order_id = o.id
     WHERE o.id = $1
     FOR UPDATE OF o`,
    [input.orderId]
  );
  const row = result.rows[0];
  if (!row) throw new CheckoutOrderError(404, "Order was not found for payout.");
  if (!row.payment_id || row.payment_status !== "paid") return null;

  const items = Array.isArray(row.items) ? (row.items as Record<string, unknown>[]) : [];
  const unknownPartIds = items
    .filter((item) => typeof item.vendorUserId !== "string")
    .map((item) => (typeof item.partId === "string" ? item.partId : ""))
    .filter(Boolean);
  const ownedParts = unknownPartIds.length
    ? await client.query<{ id: string }>(
        "SELECT id FROM parts WHERE user_id = $1 AND id = ANY($2::text[])",
        [input.vendorId, unknownPartIds]
      )
    : { rows: [] as { id: string }[] };
  const ownedPartIds = new Set(ownedParts.rows.map((part) => part.id));

  let amountNgn = 0;
  for (const item of items) {
    const belongsToVendor =
      item.vendorUserId === input.vendorId ||
      (typeof item.partId === "string" && ownedPartIds.has(item.partId));
    if (!belongsToVendor) continue;
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    if (Number.isInteger(quantity) && quantity > 0 && Number.isInteger(unitPrice) && unitPrice > 0) {
      amountNgn += quantity * unitPrice;
    }
  }
  if (amountNgn <= 0) return null;

  const payoutId = genCheckoutId("payout");
  const amountKobo = amountNgn * 100;
  const insert = await client.query<{ id: string; payout_amount_kobo: number }>(
    `INSERT INTO payout_ledger
       (id, merchant_reference, order_id, vendor_id, payment_id, gross_amount_kobo, platform_fee_kobo,
        payout_amount_kobo, currency, status, available_at)
     VALUES ($1, $1, $2, $3, $4, $5, 0, $5, 'NGN', 'held',
             NOW() + ($6::text || ' hours')::interval)
     ON CONFLICT (order_id) DO NOTHING
     RETURNING id, payout_amount_kobo`,
    [payoutId, input.orderId, input.vendorId, row.payment_id, amountKobo, payoutHoldHours()]
  );
  const payout = insert.rows[0];
  if (!payout) return null;

  await client.query(
    `INSERT INTO outbox_events
       (id, event_type, aggregate_type, aggregate_id, payload, available_at)
     VALUES ($1, 'payout.hold_created', 'payout', $2, $3::jsonb,
             NOW() + ($4::text || ' hours')::interval)`,
    [
      genCheckoutId("evt"),
      payout.id,
      JSON.stringify({ payoutId: payout.id, orderId: input.orderId, vendorId: input.vendorId }),
      payoutHoldHours(),
    ]
  );
  return { id: payout.id, amountKobo: payout.payout_amount_kobo };
}

export async function saveVendorPayoutAccount(input: {
  vendorId: string;
  accountNumber: string;
  bankCode: string;
}): Promise<{ accountName: string; bankCode: string; lastFour: string; status: string }> {
  const provider = getPaymentProvider();
  const verified = await provider.validateBankAccount({
    accountNumber: input.accountNumber,
    bankCode: input.bankCode,
  });
  const ciphertext = await encryptPayoutAccountNumber(input.vendorId, verified.accountNumber);
  const lastFour = verified.accountNumber.slice(-4);
  await query(
    `INSERT INTO vendor_payout_accounts
       (vendor_id, provider, account_reference, account_name, bank_code, last_four,
        account_number_ciphertext, status, verified_at, provider_response)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), $8::jsonb)
     ON CONFLICT (vendor_id) DO UPDATE
       SET provider = EXCLUDED.provider,
           account_name = EXCLUDED.account_name,
           bank_code = EXCLUDED.bank_code,
           last_four = EXCLUDED.last_four,
           account_number_ciphertext = EXCLUDED.account_number_ciphertext,
           status = 'active',
           verified_at = NOW(),
           provider_response = EXCLUDED.provider_response,
           updated_at = NOW()`,
    [
      input.vendorId,
      provider.id,
      genCheckoutId("acct"),
      verified.accountName,
      verified.bankCode,
      lastFour,
      ciphertext,
      JSON.stringify(verified.providerData),
    ]
  );
  return { accountName: verified.accountName, bankCode: verified.bankCode, lastFour, status: "active" };
}

export async function getVendorPayoutAccount(vendorId: string) {
  const result = await query<{
    account_name: string | null;
    bank_code: string | null;
    last_four: string | null;
    status: string;
    verified_at: string | null;
  }>(
    `SELECT account_name, bank_code, last_four, status, verified_at
     FROM vendor_payout_accounts WHERE vendor_id = $1 LIMIT 1`,
    [vendorId]
  );
  const row = result.rows[0];
  return row
    ? {
        accountName: row.account_name,
        bankCode: row.bank_code,
        lastFour: row.last_four,
        status: row.status,
        verifiedAt: row.verified_at,
      }
    : null;
}

type PayoutRow = {
  id: string;
  merchant_reference: string;
  vendor_id: string;
  payout_amount_kobo: number;
  currency: string;
  attempt_count: number;
  reconciliation_attempt_count: number;
  status: string;
  provider: string;
  provider_reference: string | null;
  account_name: string;
  bank_code: string;
  account_number_ciphertext: string;
};

function storedPayoutStatus(status: ProviderPayoutVerification["status"]): string {
  if (status === "completed") return "paid";
  if (status === "authorization_required") return "authorization_required";
  if (status === "failed") return "manual_review";
  return "processing";
}

export async function applyVerifiedPayout(input: {
  payoutReference: string;
  verification: ProviderPayoutVerification;
}): Promise<boolean> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await client.query<{
        id: string;
        merchant_reference: string;
        payout_amount_kobo: number;
        currency: string;
      }>(
        `SELECT id, merchant_reference, payout_amount_kobo, currency
         FROM payout_ledger
         WHERE merchant_reference = $1 OR provider_reference = $1
         FOR UPDATE`,
        [input.payoutReference]
      );
      const payout = result.rows[0];
      if (!payout) {
        await client.query("COMMIT");
        return false;
      }

      const verifiedMerchantReference =
        typeof input.verification.providerData.reference === "string"
          ? input.verification.providerData.reference.trim()
          : "";
      const referenceMatches = verifiedMerchantReference === payout.merchant_reference;
      const amountMatches = input.verification.amountKobo === payout.payout_amount_kobo;
      const currencyMatches = input.verification.currency.toUpperCase() === payout.currency.toUpperCase();
      if (!referenceMatches || !amountMatches || !currencyMatches) {
        const reason = !referenceMatches
          ? "Provider payout reference mismatch"
          : !amountMatches
          ? "Provider payout amount mismatch"
          : "Provider payout currency mismatch";
        await client.query(
          `UPDATE payout_ledger
           SET status = 'manual_review', failure_reason = $2,
               provider_response = $3::jsonb, updated_at = NOW()
           WHERE id = $1`,
          [payout.id, reason, JSON.stringify(input.verification.providerData)]
        );
        await client.query("COMMIT");
        logger.error({ payoutId: payout.id, reason }, "Payout reconciliation requires manual review");
        return true;
      }

      const status = storedPayoutStatus(input.verification.status);
      await client.query(
        `UPDATE payout_ledger
         SET status = $2,
             provider_reference = $3,
             provider_response = $4::jsonb,
             failure_reason = CASE WHEN $2 = 'manual_review' THEN 'Provider reported payout failure' ELSE NULL END,
             next_attempt_at = CASE WHEN $2 = 'processing' THEN NOW() + INTERVAL '5 minutes' ELSE next_attempt_at END,
             paid_at = CASE WHEN $2 = 'paid' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
             updated_at = NOW()
         WHERE id = $1`,
        [payout.id, status, input.verification.providerReference, JSON.stringify(input.verification.providerData)]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function reconcilePayout(payoutReference: string): Promise<boolean> {
  const payoutResult = await query<{
    merchant_reference: string;
    provider: string;
  }>(
    `SELECT p.merchant_reference, a.provider
     FROM payout_ledger p
     JOIN vendor_payout_accounts a ON a.vendor_id = p.vendor_id
     WHERE p.merchant_reference = $1 OR p.provider_reference = $1
     LIMIT 1`,
    [payoutReference]
  );
  const payout = payoutResult.rows[0];
  if (!payout) return false;
  const verification = await getPaymentProvider(payout.provider).verifyPayout({
    merchantReference: payout.merchant_reference,
  });
  if (!verification) return false;
  return applyVerifiedPayout({
    payoutReference: payout.merchant_reference,
    verification,
  });
}

export async function processDuePayouts(limit = 10): Promise<number> {
  if (process.env.MONNIFY_DISBURSEMENTS_ENABLED !== "true") return 0;
  await query(
    "UPDATE payout_ledger SET status = 'ready', updated_at = NOW() WHERE status = 'held' AND available_at <= NOW()"
  );
  const due = await query<PayoutRow>(
    `SELECT p.id, p.merchant_reference, p.vendor_id, p.payout_amount_kobo, p.currency,
            p.attempt_count, p.reconciliation_attempt_count, p.status, p.provider_reference,
            a.provider, a.account_name, a.bank_code, a.account_number_ciphertext
     FROM payout_ledger p
     JOIN vendor_payout_accounts a ON a.vendor_id = p.vendor_id AND a.status = 'active'
     WHERE (
         (p.status = 'ready' AND p.attempt_count = 0)
         OR (
           p.status IN ('processing', 'reconciliation_required')
           AND p.next_attempt_at <= NOW()
           AND p.reconciliation_attempt_count < 6
         )
       )
       AND a.account_number_ciphertext IS NOT NULL
     ORDER BY p.available_at
     LIMIT $1`,
    [limit]
  );
  for (const payout of due.rows) {
    if (payout.status === "ready") {
      await processPayout(payout);
    } else {
      await processPayoutReconciliation(payout);
    }
  }
  return due.rowCount;
}

async function processPayout(payout: PayoutRow): Promise<void> {
  const claimed = await query(
    `UPDATE payout_ledger
     SET status = 'processing', attempt_count = attempt_count + 1,
         next_attempt_at = NOW() + INTERVAL '5 minutes', updated_at = NOW()
     WHERE id = $1 AND status = 'ready' AND attempt_count = 0`,
    [payout.id]
  );
  if (!claimed.rowCount) return;

  try {
    const accountNumber = await decryptPayoutAccountNumber(
      payout.vendor_id,
      payout.account_number_ciphertext
    );
    const result = await getPaymentProvider(payout.provider).payout({
      reference: payout.merchant_reference,
      amountKobo: payout.payout_amount_kobo,
      currency: payout.currency,
      narration: "QuickServe vendor order payout",
      accountNumber,
      bankCode: payout.bank_code,
      accountName: payout.account_name,
    });
    await applyVerifiedPayout({
      payoutReference: payout.merchant_reference,
      verification: result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 400) : "Unknown provider response";
    logger.error({ err: error, payoutId: payout.id }, "Vendor payout requires reconciliation");
    await query(
      `UPDATE payout_ledger
       SET status = 'reconciliation_required',
           failure_reason = $2,
           next_attempt_at = NOW() + INTERVAL '5 minutes',
           updated_at = NOW()
       WHERE id = $1 AND status = 'processing'`,
      [payout.id, `Provider response uncertain; verify before any retry. ${message}`]
    );
  }
}

async function processPayoutReconciliation(payout: PayoutRow): Promise<void> {
  const claimed = await query<{ reconciliation_attempt_count: number }>(
    `UPDATE payout_ledger
     SET status = 'reconciliation_required',
         reconciliation_attempt_count = reconciliation_attempt_count + 1,
         next_attempt_at = NOW() + INTERVAL '5 minutes',
         updated_at = NOW()
     WHERE id = $1
       AND status IN ('processing', 'reconciliation_required')
       AND next_attempt_at <= NOW()
       AND reconciliation_attempt_count < 6
     RETURNING reconciliation_attempt_count`,
    [payout.id]
  );
  const attempt = claimed.rows[0]?.reconciliation_attempt_count;
  if (!attempt) return;

  try {
    const reconciled = await reconcilePayout(payout.merchant_reference);
    if (reconciled) return;
    await markUnresolvedPayout(payout.id, attempt, "Provider payout was not available for verification");
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 400) : "Payout verification failed";
    logger.error({ err: error, payoutId: payout.id, attempt }, "Vendor payout reconciliation failed");
    await markUnresolvedPayout(payout.id, attempt, message);
  }
}

async function markUnresolvedPayout(
  payoutId: string,
  attempt: number,
  message: string
): Promise<void> {
  const exhausted = attempt >= 6;
  await query(
    `UPDATE payout_ledger
     SET status = $2,
         failure_reason = $3,
         updated_at = NOW()
     WHERE id = $1 AND status = 'reconciliation_required'`,
    [
      payoutId,
      exhausted ? "manual_review" : "reconciliation_required",
      exhausted
        ? `Automatic reconciliation exhausted; manual provider review required. ${message}`
        : `Provider status still unavailable; automatic reconciliation will continue. ${message}`,
    ]
  );
}
