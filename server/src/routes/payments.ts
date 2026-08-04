import { createHash, randomBytes } from "crypto";
import { Router, Request, Response } from "express";
import { PoolClient } from "pg";
import { withClient, query } from "../db";
import { env } from "../config/env";
import { requireAuthenticated } from "../middleware/auth";
import {
  calculateCheckoutAmountKobo,
  CheckoutOrderError,
  genCheckoutId,
  insertOrderForCheckout,
  normalizeCheckoutItems,
  notifyOrderCreated,
} from "../services/orderCheckout";
import {
  getPaymentProvider,
  HostedPaymentMethod,
  ProviderVerification,
  ProviderWebhook,
} from "../services/payments";
import {
  getVendorPayoutAccount,
  reconcilePayout,
  saveVendorPayoutAccount,
} from "../services/payments/payouts";
import { reconcileRefund } from "../services/payments/refunds";
import { calculatePaymentBreakdown } from "../services/payments/fees";

const router = Router();

router.get("/return/monnify", (req: Request, res: Response) => {
  const paymentReference = typeof req.query.paymentReference === "string"
    ? req.query.paymentReference.trim().slice(0, 128)
    : "";
  const transactionReference = typeof req.query.transactionReference === "string"
    ? req.query.transactionReference.trim().slice(0, 160)
    : "";
  const params = new URLSearchParams();
  if (/^[A-Za-z0-9._:-]+$/.test(paymentReference)) {
    params.set("reference", paymentReference);
  }
  if (/^[A-Za-z0-9._|:-]+$/.test(transactionReference)) {
    params.set("providerReference", transactionReference);
  }
  const suffix = params.size ? `?${params.toString()}` : "";
  return res.redirect(302, `${env.APP_DEEP_LINK_SCHEME}://payment/complete${suffix}`);
});

type PaymentStatus =
  | "awaiting_transfer"
  | "awaiting_card"
  | "paid"
  | "rejected"
  | "expired"
  | "cancelled";

type PaymentTransactionRow = {
  id: string;
  reference: string;
  user_id: string;
  order_id: string | null;
  amount_kobo: number;
  subtotal_kobo: number | null;
  platform_fee_kobo: number | null;
  tax_kobo: number | null;
  total_kobo: number | null;
  currency: string;
  status: PaymentStatus;
  provider: string | null;
  method: string | null;
  items: unknown;
  expires_at: string | null;
  provider_response: unknown;
  provider_reference: string | null;
  checkout_url: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  idempotency_key?: string | null;
};

type DbClient = Pick<PoolClient, "query">;

function readIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function paymentProvider(): string {
  return process.env.PAYMENT_PROVIDER?.trim() || "monnify";
}

function cardPaymentProvider(): string {
  return process.env.CARD_PAYMENT_PROVIDER?.trim() || paymentProvider();
}

function paymentCurrency(): string {
  return (process.env.PAYMENT_CURRENCY || "NGN").trim().toUpperCase();
}

function platformFeeBps(): number {
  return readIntEnv("PLATFORM_FEE_BPS", 700);
}

function taxBps(): number {
  return readIntEnv("PAYMENT_TAX_BPS", 0);
}

function paymentExpiryMinutes(): number {
  return Math.max(5, readIntEnv("PAYMENT_EXPIRY_MINUTES", 40));
}

function paymentReferencePrefix(): string {
  const raw = process.env.PAYMENT_REFERENCE_PREFIX?.trim() || "SPH";
  return raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "SPH";
}

function buildPaymentReference(): string {
  return `${paymentReferencePrefix()}-${Date.now().toString(36).toUpperCase()}-${randomBytes(8)
    .toString("hex")
    .toUpperCase()}`;
}

function bankInstructions() {
  return {
    bankName: process.env.PAYMENT_BANK_NAME?.trim() || "",
    accountName: process.env.PAYMENT_ACCOUNT_NAME?.trim() || "",
    accountNumber: process.env.PAYMENT_ACCOUNT_NUMBER?.trim() || "",
  };
}

function requireBankInstructions() {
  const instructions = bankInstructions();
  if (!instructions.bankName || !instructions.accountName || !instructions.accountNumber) {
    throw new CheckoutOrderError(503, "Bank transfer details are not configured on the server.");
  }
  return instructions;
}

function calculateBreakdown(subtotalKobo: number) {
  return calculatePaymentBreakdown(subtotalKobo, {
    platformFeeBps: platformFeeBps(),
    taxBps: taxBps(),
    currency: paymentCurrency(),
  });
}

function idempotencyKey(req: Request): string | null {
  const value = req.header("idempotency-key") ||
    (typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : "");
  const normalized = value.trim();
  if (!normalized) return null;
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized)) {
    throw new CheckoutOrderError(400, "Idempotency-Key must be 8-128 URL-safe characters.");
  }
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function checkoutFingerprint(method: HostedPaymentMethod, items: Record<string, any>[]): string {
  const trustedLines = items.map((item) => {
    const location = item.deliveryLocation as Record<string, unknown> | undefined;
    return {
      partId: typeof item.partId === "string" ? item.partId : null,
      bargainOfferId: typeof item.bargainOfferId === "string" ? item.bargainOfferId : null,
      sourceRequestId: typeof item.sourceRequestId === "string" ? item.sourceRequestId : null,
      sourceQuoteId: typeof item.sourceQuoteId === "string" ? item.sourceQuoteId : null,
      vendorUserId: typeof item.vendorUserId === "string" ? item.vendorUserId : null,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice),
      deliveryLocation: location
        ? {
            formattedAddress: location.formattedAddress,
            latitude: location.latitude,
            longitude: location.longitude,
            placeId: location.placeId ?? null,
            addressComponents: location.addressComponents ?? [],
            instructions: location.instructions ?? null,
            landmark: location.landmark ?? null,
          }
        : null,
    };
  });
  const canonicalLines = trustedLines.map((line) => canonicalJson(line)).sort();
  return createHash("sha256")
    .update(`${method}:${canonicalLines.join("|")}`)
    .digest("hex");
}

async function waitForCheckoutInitialization(payment: PaymentTransactionRow): Promise<PaymentTransactionRow> {
  if (payment.checkout_url || !["awaiting_transfer", "awaiting_card"].includes(payment.status)) {
    return payment;
  }

  let latest = payment;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await query<PaymentTransactionRow>(
      "SELECT * FROM payment_transactions WHERE id = $1 LIMIT 1",
      [payment.id]
    );
    if (!result.rows[0]) return latest;
    latest = result.rows[0];
    if (latest.checkout_url || !["awaiting_transfer", "awaiting_card"].includes(latest.status)) {
      return latest;
    }
  }
  return latest;
}

function itemPartQuantities(items: Record<string, any>[]): Map<string, number> {
  const quantities = new Map<string, number>();
  for (const item of items) {
    const partId = typeof item.partId === "string" ? item.partId.trim() : "";
    const quantity = Number(item.quantity);
    if (partId && Number.isInteger(quantity) && quantity > 0) {
      quantities.set(partId, (quantities.get(partId) || 0) + quantity);
    }
  }
  return quantities;
}

async function reserveCheckoutSources(
  client: DbClient,
  paymentId: string,
  items: Record<string, any>[],
  expiresAt: Date
): Promise<void> {
  for (const item of items) {
    const bargainOfferId = typeof item.bargainOfferId === "string" ? item.bargainOfferId.trim() : "";
    if (bargainOfferId) {
      const result = await client.query(
        `UPDATE bargain_offers
         SET reserved_payment_id = $1, reserved_until = $2, updated_at = NOW()
         WHERE id = $3
           AND used_order_id IS NULL
           AND (reserved_payment_id IS NULL OR reserved_payment_id = $1 OR reserved_until < NOW())`,
        [paymentId, expiresAt, bargainOfferId]
      );
      if (!result.rowCount) {
        throw new CheckoutOrderError(409, "This accepted bargain is already in another checkout.");
      }
    }

    const quoteId = typeof item.sourceQuoteId === "string" ? item.sourceQuoteId.trim() : "";
    if (quoteId) {
      const result = await client.query(
        `UPDATE part_request_quotes
         SET reserved_payment_id = $1, reserved_until = $2, updated_at = NOW()
         WHERE id = $3
           AND (reserved_payment_id IS NULL OR reserved_payment_id = $1 OR reserved_until < NOW())`,
        [paymentId, expiresAt, quoteId]
      );
      if (!result.rowCount) {
        throw new CheckoutOrderError(409, "This quote is already in another checkout.");
      }
    }
  }
}

async function reserveInventory(
  client: DbClient,
  paymentId: string,
  items: Record<string, any>[],
  expiresAt: Date
): Promise<void> {
  for (const [partId, quantity] of itemPartQuantities(items)) {
    const result = await client.query<{ stock_qty: number | null }>(
      `UPDATE parts
       SET stock_qty = stock_qty - $2
       WHERE id = $1 AND stock_qty IS NOT NULL AND stock_qty >= $2
       RETURNING stock_qty`,
      [partId, quantity]
    );

    if (!result.rows[0]) {
      const part = await client.query<{ stock_qty: number | null }>(
        "SELECT stock_qty FROM parts WHERE id = $1",
        [partId]
      );
      if (!part.rows[0]) throw new CheckoutOrderError(404, "A checkout item was not found.");
      if (part.rows[0].stock_qty !== null) {
        throw new CheckoutOrderError(409, "Requested quantity is no longer available.");
      }
      continue;
    }

    await client.query(
      `INSERT INTO inventory_reservations
         (id, payment_id, part_id, quantity, status, expires_at)
       VALUES ($1, $2, $3, $4, 'reserved', $5)
       ON CONFLICT (payment_id, part_id) DO NOTHING`,
      [genCheckoutId("res"), paymentId, partId, quantity, expiresAt]
    );
  }
}

async function releaseCheckoutReservations(client: DbClient, paymentId: string): Promise<void> {
  const reservations = await client.query<{ id: string; part_id: string; quantity: number }>(
    `SELECT id, part_id, quantity
     FROM inventory_reservations
     WHERE payment_id = $1 AND status = 'reserved'
     FOR UPDATE`,
    [paymentId]
  );
  for (const reservation of reservations.rows) {
    await client.query("UPDATE parts SET stock_qty = stock_qty + $2 WHERE id = $1", [
      reservation.part_id,
      reservation.quantity,
    ]);
  }
  await client.query(
    `UPDATE inventory_reservations
     SET status = 'released', released_at = NOW()
     WHERE payment_id = $1 AND status = 'reserved'`,
    [paymentId]
  );
  await client.query(
    "UPDATE bargain_offers SET reserved_payment_id = NULL, reserved_until = NULL WHERE reserved_payment_id = $1",
    [paymentId]
  );
  await client.query(
    "UPDATE part_request_quotes SET reserved_payment_id = NULL, reserved_until = NULL WHERE reserved_payment_id = $1",
    [paymentId]
  );
}

async function consumeCheckoutReservations(client: DbClient, paymentId: string): Promise<void> {
  await client.query(
    `UPDATE inventory_reservations
     SET status = 'consumed', consumed_at = NOW()
     WHERE payment_id = $1 AND status = 'reserved'`,
    [paymentId]
  );
  await client.query(
    "UPDATE bargain_offers SET reserved_payment_id = NULL, reserved_until = NULL WHERE reserved_payment_id = $1",
    [paymentId]
  );
  await client.query(
    "UPDATE part_request_quotes SET reserved_payment_id = NULL, reserved_until = NULL WHERE reserved_payment_id = $1",
    [paymentId]
  );
}

function providerStatusToPaymentStatus(status: ProviderVerification["status"]): PaymentStatus | null {
  if (status === "expired") return "expired";
  if (status === "failed") return "rejected";
  return null;
}

function publicPayment(row: PaymentTransactionRow) {
  const subtotalKobo = row.subtotal_kobo ?? row.amount_kobo;
  const platformFeeKobo = row.platform_fee_kobo ?? 0;
  const taxKobo = row.tax_kobo ?? 0;
  const totalKobo = row.total_kobo ?? row.amount_kobo;
  return {
    reference: row.reference,
    orderId: row.order_id,
    userId: row.user_id,
    provider: row.provider || paymentProvider(),
    method: row.method || "bank_transfer",
    status: row.status,
    subtotalKobo,
    platformFeeKobo,
    taxKobo,
    totalKobo,
    amountKobo: totalKobo,
    currency: row.currency,
    checkoutUrl: row.checkout_url,
    providerReference: row.provider_reference,
    reviewNote: row.failure_reason,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
    bankInstructions: row.provider === "monnify" ? { bankName: "", accountName: "", accountNumber: "" } : bankInstructions(),
  };
}

function userCanReadPayment(user: { id: string; role: string }, payment: PaymentTransactionRow): boolean {
  return payment.user_id === user.id || user.role === "admin" || user.role === "staff";
}

async function finalizeAutomaticPayment(input: {
  reference: string;
  amountKobo: number;
  currency: string;
  providerPayload: Record<string, unknown>;
  log: Request["log"];
}): Promise<{ payment: PaymentTransactionRow; orderCreated: boolean }> {
  let notificationPayload: { orderId: string; userId: string; items: Record<string, any>[] } | null = null;

  const result = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const { rows } = await client.query<PaymentTransactionRow>(
        `SELECT *
         FROM payment_transactions
         WHERE reference = $1
         FOR UPDATE`,
        [input.reference],
      );
      const payment = rows[0];
      if (!payment) {
        await client.query("ROLLBACK");
        return { error: new CheckoutOrderError(404, "Payment reference was not found.") };
      }
      if (payment.order_id) {
        await client.query("COMMIT");
        return { payment, orderCreated: false };
      }
      if (!["awaiting_transfer", "awaiting_card"].includes(payment.status)) {
        await client.query("ROLLBACK");
        return { error: new CheckoutOrderError(409, "This payment cannot be confirmed in its current state.") };
      }
      if (payment.expires_at && new Date(payment.expires_at).getTime() < Date.now()) {
        await releaseCheckoutReservations(client, payment.id);
        await client.query(
          `UPDATE payment_transactions
           SET status = 'expired', updated_at = NOW()
           WHERE reference = $1`,
          [payment.reference],
        );
        await client.query("COMMIT");
        return { error: new CheckoutOrderError(409, "This payment reference has expired.") };
      }

      const expectedAmount = payment.total_kobo ?? payment.amount_kobo;
      if (input.amountKobo !== expectedAmount) {
        await releaseCheckoutReservations(client, payment.id);
        await client.query(
          `UPDATE payment_transactions
           SET status = 'rejected',
               failure_reason = $2,
               provider_response = $3::jsonb,
               verified_at = NOW(),
               updated_at = NOW()
           WHERE reference = $1`,
          [
            payment.reference,
            "Transfer amount mismatch",
            JSON.stringify(input.providerPayload),
          ],
        );
        await client.query("COMMIT");
        return { error: new CheckoutOrderError(409, "Payment amount mismatch.") };
      }
      if (input.currency.toUpperCase() !== payment.currency.toUpperCase()) {
        await releaseCheckoutReservations(client, payment.id);
        await client.query(
          `UPDATE payment_transactions
           SET status = 'rejected', failure_reason = 'Payment currency mismatch',
               verified_at = NOW(), updated_at = NOW()
           WHERE reference = $1`,
          [payment.reference]
        );
        await client.query("COMMIT");
        return { error: new CheckoutOrderError(409, "Payment currency mismatch.") };
      }

      const items = Array.isArray(payment.items) ? (payment.items as Record<string, any>[]) : [];
      const order = await insertOrderForCheckout(client, {
        userId: payment.user_id,
        items,
      });
      await consumeCheckoutReservations(client, payment.id);

      const updated = await client.query<PaymentTransactionRow>(
        `UPDATE payment_transactions
         SET status = 'paid',
             order_id = $2,
             paid_at = NOW(),
             verified_at = NOW(),
             provider_response = $3::jsonb,
             updated_at = NOW()
         WHERE reference = $1
         RETURNING *`,
        [payment.reference, order.id, JSON.stringify(input.providerPayload)],
      );

      notificationPayload = {
        orderId: order.id,
        userId: payment.user_id,
        items,
      };
      await client.query(
        `INSERT INTO outbox_events
           (id, event_type, aggregate_type, aggregate_id, payload)
         VALUES ($1, 'order.created', 'order', $2, $3::jsonb)`,
        [
          genCheckoutId("evt"),
          order.id,
          JSON.stringify({ orderId: order.id, userId: payment.user_id }),
        ]
      );
      await client.query("COMMIT");
      return { payment: updated.rows[0] || payment, orderCreated: true };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });

  if ("error" in result) {
    throw result.error;
  }

  if (notificationPayload) {
    await notifyOrderCreated(input.log, notificationPayload);
  }
  return result;
}

async function createMonnifyPendingCheckout(input: {
  user: { id: string; role: string };
  rawItems: unknown[];
  method: HostedPaymentMethod;
  idempotencyKey: string | null;
}): Promise<PaymentTransactionRow> {
  const setup = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      if (input.idempotencyKey) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `${input.user.id}:${input.idempotencyKey}`,
        ]);
        const existing = await client.query<PaymentTransactionRow>(
          `SELECT * FROM payment_transactions
           WHERE user_id = $1 AND idempotency_key = $2
           LIMIT 1`,
          [input.user.id, input.idempotencyKey]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].method !== input.method) {
            throw new CheckoutOrderError(409, "This idempotency key was used for another payment method.");
          }
          await client.query("COMMIT");
          return {
            payment: existing.rows[0],
            itemCount: Array.isArray(existing.rows[0].items) ? existing.rows[0].items.length : 0,
            customer: null,
            shouldInitialize: false,
          };
        }
      }

      const items = await normalizeCheckoutItems(client, input.user.id, input.rawItems);
      const subtotalKobo = calculateCheckoutAmountKobo(items);
      const breakdown = calculateBreakdown(subtotalKobo);
      const fingerprint = checkoutFingerprint(input.method, items);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${input.user.id}:checkout:${fingerprint}`,
      ]);
      const activePayments = await client.query<PaymentTransactionRow>(
        `SELECT * FROM payment_transactions
         WHERE user_id = $1
           AND method = $2
           AND status IN ('awaiting_transfer', 'awaiting_card')
           AND expires_at > NOW()
         ORDER BY created_at DESC`,
        [input.user.id, input.method]
      );
      const equivalent = activePayments.rows.find((payment) => {
        const paymentItems = Array.isArray(payment.items)
          ? (payment.items as Record<string, any>[])
          : [];
        return (
          checkoutFingerprint(input.method, paymentItems) === fingerprint &&
          (payment.total_kobo ?? payment.amount_kobo) === breakdown.totalKobo &&
          payment.currency.toUpperCase() === breakdown.currency.toUpperCase()
        );
      });
      if (equivalent) {
        await client.query("COMMIT");
        return {
          payment: equivalent,
          itemCount: items.length,
          customer: null,
          shouldInitialize: false,
        };
      }

      const expiresMinutes = paymentExpiryMinutes();
      const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000);
      const reference = buildPaymentReference();
      const status: PaymentStatus = input.method === "card" ? "awaiting_card" : "awaiting_transfer";
      const provider = getPaymentProvider();
      const paymentId = genCheckoutId("pay");
      const customerResult = await client.query<{
        email: string;
        display_name: string;
      }>(
        `SELECT email,
                TRIM(CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, ''))) AS display_name
         FROM users
         WHERE id = $1 AND deleted_at IS NULL
         LIMIT 1`,
        [input.user.id]
      );
      const customer = customerResult.rows[0];
      if (!customer?.email) throw new CheckoutOrderError(403, "Customer account is not available.");

      const { rows } = await client.query<PaymentTransactionRow>(
        `INSERT INTO payment_transactions
           (id, reference, user_id, amount_kobo, subtotal_kobo, platform_fee_kobo, tax_kobo,
            total_kobo, currency, status, provider, method, items, expires_at, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $4, $8, $9, $10, $11, $12::jsonb,
                 $13, $14)
         RETURNING *`,
        [
          paymentId,
          reference,
          input.user.id,
          breakdown.totalKobo,
          breakdown.subtotalKobo,
          breakdown.platformFeeKobo,
          breakdown.taxKobo,
          breakdown.currency,
          status,
          provider.id,
          input.method,
          JSON.stringify(items),
          expiresAt,
          input.idempotencyKey,
        ],
      );

      await reserveCheckoutSources(client, paymentId, items, expiresAt);
      await reserveInventory(client, paymentId, items, expiresAt);

      await client.query("COMMIT");
      return {
        payment: rows[0],
        itemCount: items.length,
        customer: {
          id: input.user.id,
          name: customer.display_name || "QuickServe customer",
          email: customer.email,
        },
        shouldInitialize: true,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });

  if (!setup.shouldInitialize) return waitForCheckoutInitialization(setup.payment);

  let customer = setup.customer;
  if (!customer) {
    const customerResult = await query<{ email: string; display_name: string }>(
      `SELECT email,
              TRIM(CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, ''))) AS display_name
       FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [input.user.id]
    );
    const row = customerResult.rows[0];
    if (!row?.email) throw new CheckoutOrderError(403, "Customer account is not available.");
    customer = { id: input.user.id, name: row.display_name || "QuickServe customer", email: row.email };
  }

  const provider = getPaymentProvider(setup.payment.provider || undefined);
  let initialized;
  try {
    initialized = await provider.initialize({
      reference: setup.payment.reference,
      totalKobo: setup.payment.total_kobo ?? setup.payment.amount_kobo,
      currency: setup.payment.currency,
      method: input.method,
      user: customer,
      itemCount: setup.itemCount,
    });
  } catch (error) {
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const locked = await client.query<{ id: string; checkout_url: string | null }>(
          "SELECT id, checkout_url FROM payment_transactions WHERE reference = $1 FOR UPDATE",
          [setup.payment.reference]
        );
        if (locked.rows[0] && !locked.rows[0].checkout_url) {
          await releaseCheckoutReservations(client, locked.rows[0].id);
          await client.query(
            `UPDATE payment_transactions
             SET status = 'cancelled', failure_reason = 'Provider initialization failed', updated_at = NOW()
             WHERE id = $1`,
            [locked.rows[0].id]
          );
        }
        await client.query("COMMIT");
      } catch (rollbackError) {
        await client.query("ROLLBACK");
        throw rollbackError;
      }
    });
    throw error;
  }

  const updated = await query<PaymentTransactionRow>(
    `UPDATE payment_transactions
     SET checkout_url = $2,
         provider_reference = $3,
         provider_response = $4::jsonb,
         updated_at = NOW()
     WHERE reference = $1
     RETURNING *`,
    [
      setup.payment.reference,
      initialized.checkoutUrl,
      initialized.providerReference || null,
      JSON.stringify(initialized.providerData),
    ],
  );

  return updated.rows[0] || setup.payment;
}

async function refreshMonnifyPayment(payment: PaymentTransactionRow, log: Request["log"]): Promise<PaymentTransactionRow> {
  if (payment.status === "paid" || payment.order_id) {
    return payment;
  }
  if (!["awaiting_transfer", "awaiting_card"].includes(payment.status)) {
    return payment;
  }

  const provider = getPaymentProvider(payment.provider || undefined);
  const verified = await provider.verify({
    paymentReference: payment.reference,
    providerReference: payment.provider_reference,
  });
  if (!verified) return payment;

  if (verified.status === "paid") {
    const result = await finalizeAutomaticPayment({
      reference: payment.reference,
      amountKobo: verified.amountKobo,
      currency: verified.currency || payment.currency,
      providerPayload: verified.providerData,
      log,
    });
    return result.payment;
  }

  const nextStatus = providerStatusToPaymentStatus(verified.status);
  if (nextStatus) {
    return withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const locked = await client.query<PaymentTransactionRow>(
          "SELECT * FROM payment_transactions WHERE reference = $1 FOR UPDATE",
          [payment.reference]
        );
        const current = locked.rows[0];
        if (!current || !["awaiting_transfer", "awaiting_card"].includes(current.status)) {
          await client.query("COMMIT");
          return current || payment;
        }
        await releaseCheckoutReservations(client, current.id);
        const updated = await client.query<PaymentTransactionRow>(
          `UPDATE payment_transactions
           SET status = $2, failure_reason = $3, provider_response = $4::jsonb,
               verified_at = NOW(), updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [current.id, nextStatus, `Provider payment status: ${verified.status}`, JSON.stringify(verified.providerData)]
        );
        await client.query("COMMIT");
        return updated.rows[0] || current;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  return payment;
}

router.post("/checkout/initialize", requireAuthenticated, async (req: Request, res: Response) => {
  const user = req.user;
  const log = req.log;
  if (!user) {
    return res.status(401).json({ ok: false, message: "Authentication required" });
  }

  try {
    const rawItems = Array.isArray((req.body as { items?: unknown[] })?.items)
      ? (req.body as { items: unknown[] }).items
      : [];

    const payment = await createMonnifyPendingCheckout({
      user,
      rawItems,
      method: "bank_transfer",
      idempotencyKey: idempotencyKey(req),
    });

    log.info({ reference: payment.reference, userId: user.id }, "Monnify bank transfer checkout initialized");
    return res.status(201).json({ ok: true, payment: publicPayment(payment) });
  } catch (err) {
    if (err instanceof CheckoutOrderError) {
      return res.status(err.status).json({ ok: false, message: err.message });
    }
    log.error({ err, userId: user.id }, "Payment initialize failed");
    throw err;
  }
});

router.post("/card/initialize", requireAuthenticated, async (req: Request, res: Response) => {
  const user = req.user;
  const log = req.log;
  if (!user) {
    return res.status(401).json({ ok: false, message: "Authentication required" });
  }

  try {
    const rawItems = Array.isArray((req.body as { items?: unknown[] })?.items)
      ? (req.body as { items: unknown[] }).items
      : [];

    const payment = await createMonnifyPendingCheckout({
      user,
      rawItems,
      method: "card",
      idempotencyKey: idempotencyKey(req),
    });

    log.info({ reference: payment.reference, userId: user.id }, "Monnify card checkout initialized");
    return res.status(201).json({ ok: true, payment: publicPayment(payment) });
  } catch (err) {
    if (err instanceof CheckoutOrderError) {
      return res.status(err.status).json({ ok: false, message: err.message });
    }
    log.error({ err, userId: user.id }, "Card checkout initialize failed");
    throw err;
  }
});

router.get("/payout-account", requireAuthenticated, async (req: Request, res: Response) => {
  if (!req.user || req.user.role !== "vendor") {
    return res.status(403).json({ ok: false, message: "Only vendors can view payout settings" });
  }
  const account = await getVendorPayoutAccount(req.user.id);
  return res.json({ ok: true, account });
});

router.put("/payout-account", requireAuthenticated, async (req: Request, res: Response) => {
  if (!req.user || req.user.role !== "vendor") {
    return res.status(403).json({ ok: false, message: "Only vendors can update payout settings" });
  }
  const accountNumber = typeof req.body?.accountNumber === "string"
    ? req.body.accountNumber.replace(/\s+/g, "")
    : "";
  const bankCode = typeof req.body?.bankCode === "string" ? req.body.bankCode.trim() : "";
  if (!/^\d{10}$/.test(accountNumber) || !/^\d{3,6}$/.test(bankCode)) {
    return res.status(400).json({ ok: false, message: "Enter a valid Nigerian account number and bank code" });
  }
  try {
    const account = await saveVendorPayoutAccount({
      vendorId: req.user.id,
      accountNumber,
      bankCode,
    });
    req.log.info({ vendorId: req.user.id }, "Vendor payout account verified");
    return res.json({ ok: true, account });
  } catch (error) {
    if (error instanceof CheckoutOrderError) {
      return res.status(error.status).json({ ok: false, message: error.message });
    }
    req.log.error({ err: error, vendorId: req.user.id }, "Vendor payout account update failed");
    return res.status(503).json({ ok: false, message: "Payout account verification is temporarily unavailable" });
  }
});

router.get("/checkout/:reference", requireAuthenticated, async (req: Request, res: Response) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ ok: false, message: "Authentication required" });
  }
  const { rows } = await query<PaymentTransactionRow>(
    `SELECT *
     FROM payment_transactions
     WHERE reference = $1
     LIMIT 1`,
    [String(req.params.reference)],
  );
  const payment = rows[0];
  if (!payment) {
    return res.status(404).json({ ok: false, message: "Payment reference was not found." });
  }
  if (!userCanReadPayment(user, payment)) {
    return res.status(403).json({ ok: false, message: "Not authorized" });
  }

  try {
    const refreshed = await refreshMonnifyPayment(payment, req.log);
    return res.json({ ok: true, payment: publicPayment(refreshed) });
  } catch (err) {
    if (err instanceof CheckoutOrderError) {
      return res.status(err.status).json({ ok: false, message: err.message });
    }
    req.log.error({ err, reference: payment.reference }, "Monnify payment refresh failed");
    throw err;
  }
});

export async function processMonnifyWebhookEvent(
  event: ProviderWebhook,
  log: Request["log"],
): Promise<void> {
  const provider = getPaymentProvider("monnify");
  const { paymentReference, providerReference } = event;

  if (event.payoutReference && event.eventType.toUpperCase().includes("DISBURSEMENT")) {
    const reconciled = await reconcilePayout(event.payoutReference);
    if (!reconciled) throw new Error("Monnify payout was not available for verification");
    return;
  }

  if (event.refundReference) {
    const reconciled = await reconcileRefund(event.refundReference);
    if (!reconciled) throw new Error("Monnify refund was not available for verification");
    return;
  }

  if (!paymentReference) {
    log.warn({ eventType: event.eventType }, "Ignoring Monnify webhook without a payment reference");
    return;
  }

  const verified = await provider.verify({
    paymentReference,
    providerReference,
  });
  if (!verified) {
    throw new Error("Monnify transaction was not available for verification");
  }

  if (verified.status !== "paid") {
    const paymentResult = await query<PaymentTransactionRow>(
      "SELECT * FROM payment_transactions WHERE reference = $1 LIMIT 1",
      [paymentReference]
    );
    if (paymentResult.rows[0]) {
      await refreshMonnifyPayment(paymentResult.rows[0], log);
    }
    return;
  }

  await finalizeAutomaticPayment({
    reference: paymentReference,
    amountKobo: verified.amountKobo,
    currency: verified.currency || paymentCurrency(),
    providerPayload: verified.providerData,
    log,
  });
}

function normalizedIp(value: string | undefined): string {
  return (value || "").replace(/^::ffff:/, "").trim();
}

router.post("/webhook/monnify", async (req: Request, res: Response) => {
  const allowedIps = new Set(
    (env.MONNIFY_WEBHOOK_IPS || "")
      .split(",")
      .map(normalizedIp)
      .filter(Boolean),
  );
  if (env.isProduction && !allowedIps.has(normalizedIp(req.ip))) {
    req.log.warn({ sourceIp: normalizedIp(req.ip) }, "Rejected Monnify webhook source");
    return res.status(403).json({ ok: false, message: "Webhook source is not allowed" });
  }

  const provider = getPaymentProvider("monnify");
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody || !provider.verifyWebhook({
    rawBody,
    signature: req.header("monnify-signature") || undefined,
  })) {
    req.log.warn("Invalid Monnify webhook signature");
    return res.status(401).json({ ok: false, message: "Invalid signature" });
  }

  const parsed = provider.parseWebhook((req.body || {}) as Record<string, unknown>);
  const event: ProviderWebhook = {
    eventType: parsed.eventType.slice(0, 100),
    paymentReference: parsed.paymentReference.slice(0, 128),
    providerReference: parsed.providerReference.slice(0, 160),
    refundReference: parsed.refundReference?.slice(0, 160),
    payoutReference: parsed.payoutReference?.slice(0, 160),
    body: {
      status: typeof parsed.body.status === "string" ? parsed.body.status.slice(0, 80) : undefined,
      refundStatus:
        typeof parsed.body.refundStatus === "string" ? parsed.body.refundStatus.slice(0, 80) : undefined,
      amount:
        typeof parsed.body.amount === "number" || typeof parsed.body.amount === "string"
          ? parsed.body.amount
          : undefined,
    },
  };
  const webhookId = `webhook_${createHash("sha256").update(rawBody).digest("hex")}`;
  await query(
    `INSERT INTO outbox_events
       (id, event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1, 'payment.monnify_webhook', 'payment_provider', $2, $3::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      webhookId,
      event.paymentReference || event.refundReference || event.payoutReference || webhookId,
      JSON.stringify(event),
    ],
  );
  return res.json({ ok: true, accepted: true });
});

export default router;
