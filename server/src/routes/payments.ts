import { createHmac, timingSafeEqual } from "crypto";
import { Router, Request, Response } from "express";
import { PoolClient } from "pg";
import { withClient, query } from "../db";
import { requireAuthenticated } from "../middleware/auth";
import {
  calculateCheckoutAmountKobo,
  CheckoutOrderError,
  genCheckoutId,
  insertOrderForCheckout,
  normalizeCheckoutItems,
  notifyOrderCreated,
} from "../services/orderCheckout";

const router = Router();

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
  created_at: string;
  updated_at: string;
  paid_at: string | null;
};

type DbClient = Pick<PoolClient, "query">;

function readIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function paymentProvider(): string {
  return process.env.PAYMENT_PROVIDER?.trim() || "manual_bank_transfer";
}

function cardPaymentProvider(): string {
  return process.env.CARD_PAYMENT_PROVIDER?.trim() || "hosted_card";
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
  return Math.max(5, readIntEnv("PAYMENT_EXPIRY_MINUTES", 1440));
}

function paymentReferencePrefix(): string {
  const raw = process.env.PAYMENT_REFERENCE_PREFIX?.trim() || "SPH";
  return raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "SPH";
}

function buildPaymentReference(): string {
  return `${paymentReferencePrefix()}-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 8)
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
  const platformFeeKobo = Math.ceil((subtotalKobo * platformFeeBps()) / 10000);
  const taxKobo = Math.ceil((subtotalKobo * taxBps()) / 10000);
  return {
    subtotalKobo,
    platformFeeKobo,
    taxKobo,
    totalKobo: subtotalKobo + platformFeeKobo + taxKobo,
    currency: paymentCurrency(),
  };
}

async function ensurePaymentTransactionsTable(client: DbClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS payment_transactions (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id),
      order_id TEXT UNIQUE REFERENCES orders(id) ON DELETE SET NULL,
      amount_kobo INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      status TEXT NOT NULL,
      items JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS provider TEXT");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS method TEXT");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS subtotal_kobo INTEGER");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS platform_fee_kobo INTEGER");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS tax_kobo INTEGER DEFAULT 0");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS total_kobo INTEGER");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS failure_reason TEXT");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS provider_response JSONB");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS provider_reference TEXT");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS checkout_url TEXT");
  await client.query("UPDATE payment_transactions SET total_kobo = amount_kobo WHERE total_kobo IS NULL");
  await client.query("UPDATE payment_transactions SET subtotal_kobo = amount_kobo WHERE subtotal_kobo IS NULL");
  await client.query("UPDATE payment_transactions SET platform_fee_kobo = 0 WHERE platform_fee_kobo IS NULL");
  await client.query("UPDATE payment_transactions SET tax_kobo = 0 WHERE tax_kobo IS NULL");
  await client.query("CREATE INDEX IF NOT EXISTS idx_payment_transactions_user_created ON payment_transactions (user_id, created_at DESC)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON payment_transactions (status, created_at DESC)");
}

async function ensurePaymentTransactionsSchema(): Promise<void> {
  await withClient(async (client) => {
    await ensurePaymentTransactionsTable(client);
  });
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
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
    bankInstructions: bankInstructions(),
  };
}

function userCanReadPayment(user: { id: string; role: string }, payment: PaymentTransactionRow): boolean {
  return payment.user_id === user.id || user.role === "admin" || user.role === "staff";
}

function isSuccessfulPaymentStatus(value: unknown): boolean {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["success", "successful", "paid", "completed", "confirmed"].includes(normalized);
}

function readWebhookAmountKobo(body: Record<string, unknown>): number {
  const raw =
    body.amountKobo ??
    body.amount_kobo ??
    body.totalKobo ??
    body.total_kobo ??
    body.paidAmountKobo ??
    body.paid_amount_kobo;
  const numeric = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(numeric) ? Math.round(numeric) : 0;
}

function verifyTransferWebhookSignature(req: Request): boolean {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET?.trim();
  if (!secret) return false;
  const signature =
    req.header("x-sph-payment-signature") ||
    req.header("x-payment-signature") ||
    req.header("x-webhook-signature") ||
    "";
  if (!signature) return false;

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const bodyBuffer = rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expected = createHmac("sha256", secret).update(bodyBuffer).digest("hex");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function verifyCardWebhookSignature(req: Request): boolean {
  const secret =
    process.env.CARD_WEBHOOK_SECRET?.trim() ||
    process.env.PAYMENT_WEBHOOK_SECRET?.trim();
  if (!secret) return false;
  const signature =
    req.header("x-sph-card-signature") ||
    req.header("x-sph-payment-signature") ||
    req.header("x-payment-signature") ||
    req.header("x-webhook-signature") ||
    "";
  if (!signature) return false;

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const bodyBuffer = rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expected = createHmac("sha256", secret).update(bodyBuffer).digest("hex");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
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
      await ensurePaymentTransactionsTable(client);
      const { rows } = await client.query<PaymentTransactionRow>(
        `SELECT *
         FROM payment_transactions
         WHERE reference = $1
         FOR UPDATE`,
        [input.reference],
      );
      const payment = rows[0];
      if (!payment) {
        throw new CheckoutOrderError(404, "Payment reference was not found.");
      }
      if (payment.order_id) {
        await client.query("COMMIT");
        return { payment, orderCreated: false };
      }
      if (!["awaiting_transfer", "awaiting_card"].includes(payment.status)) {
        throw new CheckoutOrderError(409, "This payment cannot be confirmed in its current state.");
      }
      if (payment.expires_at && new Date(payment.expires_at).getTime() < Date.now()) {
        await client.query(
          `UPDATE payment_transactions
           SET status = 'expired', updated_at = NOW()
           WHERE reference = $1`,
          [payment.reference],
        );
        throw new CheckoutOrderError(409, "This payment reference has expired.");
      }

      const expectedAmount = payment.total_kobo ?? payment.amount_kobo;
      if (input.amountKobo !== expectedAmount) {
        await client.query(
          `UPDATE payment_transactions
           SET failure_reason = $2,
               provider_response = $3::jsonb,
               updated_at = NOW()
           WHERE reference = $1`,
          [
            payment.reference,
            "Transfer amount mismatch",
            JSON.stringify(input.providerPayload),
          ],
        );
        throw new CheckoutOrderError(409, "Transfer amount mismatch.");
      }
      if (input.currency.toUpperCase() !== payment.currency.toUpperCase()) {
        throw new CheckoutOrderError(409, "Transfer currency mismatch.");
      }

      const items = Array.isArray(payment.items) ? (payment.items as Record<string, any>[]) : [];
      const order = await insertOrderForCheckout(client, {
        userId: payment.user_id,
        items,
      });

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
      await client.query("COMMIT");
      return { payment: updated.rows[0] || payment, orderCreated: true };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });

  if (notificationPayload) {
    await notifyOrderCreated(input.log, notificationPayload);
  }
  return result;
}

router.post("/checkout/initialize", requireAuthenticated, async (req: Request, res: Response) => {
  const user = req.user;
  const log = req.log;
  if (!user) {
    return res.status(401).json({ ok: false, message: "Authentication required" });
  }

  try {
    const bank = requireBankInstructions();
    const rawItems = Array.isArray((req.body as { items?: unknown[] })?.items)
      ? (req.body as { items: unknown[] }).items
      : [];

    const payment = await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await ensurePaymentTransactionsTable(client);
        const items = await normalizeCheckoutItems(client, user.id, rawItems);
        const subtotalKobo = calculateCheckoutAmountKobo(items);
        const breakdown = calculateBreakdown(subtotalKobo);
        const expiresMinutes = paymentExpiryMinutes();

        const { rows } = await client.query<PaymentTransactionRow>(
          `INSERT INTO payment_transactions
             (id, reference, user_id, amount_kobo, subtotal_kobo, platform_fee_kobo, tax_kobo,
              total_kobo, currency, status, provider, method, items, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $4, $8, 'awaiting_transfer',
                   $9, 'bank_transfer', $10::jsonb, NOW() + ($11::text || ' minutes')::interval)
           RETURNING *`,
          [
            genCheckoutId("pay"),
            buildPaymentReference(),
            user.id,
            breakdown.totalKobo,
            breakdown.subtotalKobo,
            breakdown.platformFeeKobo,
            breakdown.taxKobo,
            breakdown.currency,
            paymentProvider(),
            JSON.stringify(items),
            expiresMinutes,
          ],
        );

        await client.query("COMMIT");
        return rows[0];
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    });

    log.info({ reference: payment.reference, userId: user.id }, "Bank transfer checkout initialized");
    return res.status(201).json({ ok: true, payment: publicPayment(payment), bankInstructions: bank });
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

  const initUrl = process.env.CARD_CHECKOUT_INIT_URL?.trim();
  const secret = process.env.CARD_CHECKOUT_SECRET?.trim();
  if (!initUrl || !secret) {
    return res.status(503).json({
      ok: false,
      message: "Card checkout provider is not configured on the server.",
    });
  }

  try {
    const rawItems = Array.isArray((req.body as { items?: unknown[] })?.items)
      ? (req.body as { items: unknown[] }).items
      : [];

    const setup = await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await ensurePaymentTransactionsTable(client);
        const items = await normalizeCheckoutItems(client, user.id, rawItems);
        const subtotalKobo = calculateCheckoutAmountKobo(items);
        const breakdown = calculateBreakdown(subtotalKobo);
        const expiresMinutes = paymentExpiryMinutes();
        const reference = buildPaymentReference();

        const { rows } = await client.query<PaymentTransactionRow>(
          `INSERT INTO payment_transactions
             (id, reference, user_id, amount_kobo, subtotal_kobo, platform_fee_kobo, tax_kobo,
              total_kobo, currency, status, provider, method, items, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $4, $8, 'awaiting_card',
                   $9, 'card', $10::jsonb, NOW() + ($11::text || ' minutes')::interval)
           RETURNING *`,
          [
            genCheckoutId("pay"),
            reference,
            user.id,
            breakdown.totalKobo,
            breakdown.subtotalKobo,
            breakdown.platformFeeKobo,
            breakdown.taxKobo,
            breakdown.currency,
            cardPaymentProvider(),
            JSON.stringify(items),
            expiresMinutes,
          ],
        );

        await client.query("COMMIT");
        return { payment: rows[0], items };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    });

    const callbackUrl =
      typeof req.body?.callbackUrl === "string" && req.body.callbackUrl.trim()
        ? req.body.callbackUrl.trim()
        : process.env.CARD_CHECKOUT_CALLBACK_URL?.trim();
    const webhookUrl = process.env.CARD_CHECKOUT_WEBHOOK_URL?.trim();

    const providerResponse = await fetch(initUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reference: setup.payment.reference,
        amountKobo: setup.payment.total_kobo ?? setup.payment.amount_kobo,
        currency: setup.payment.currency,
        callbackUrl,
        webhookUrl,
        metadata: {
          userId: user.id,
          source: "spare_parts_hub_mobile",
          paymentMethod: "card",
          itemCount: setup.items.length,
        },
      }),
    });
    const providerPayload = (await providerResponse.json().catch(() => null)) as
      | {
          checkoutUrl?: string;
          checkout_url?: string;
          authorizationUrl?: string;
          authorization_url?: string;
          providerReference?: string;
          provider_reference?: string;
          reference?: string;
          message?: string;
        }
      | null;

    if (!providerResponse.ok) {
      throw new CheckoutOrderError(
        providerResponse.status >= 500 ? 502 : 400,
        providerPayload?.message || "Card provider checkout initialization failed.",
      );
    }

    const checkoutUrl =
      providerPayload?.checkoutUrl ||
      providerPayload?.checkout_url ||
      providerPayload?.authorizationUrl ||
      providerPayload?.authorization_url ||
      "";
    const providerReference =
      providerPayload?.providerReference ||
      providerPayload?.provider_reference ||
      providerPayload?.reference ||
      "";

    if (!checkoutUrl) {
      throw new CheckoutOrderError(502, "Card provider did not return a checkout URL.");
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
        checkoutUrl,
        providerReference || null,
        JSON.stringify(providerPayload || {}),
      ],
    );

    log.info({ reference: setup.payment.reference, userId: user.id }, "Card checkout initialized");
    return res.status(201).json({ ok: true, payment: publicPayment(updated.rows[0]) });
  } catch (err) {
    if (err instanceof CheckoutOrderError) {
      return res.status(err.status).json({ ok: false, message: err.message });
    }
    log.error({ err, userId: user.id }, "Card checkout initialize failed");
    throw err;
  }
});

router.get("/checkout/:reference", requireAuthenticated, async (req: Request, res: Response) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ ok: false, message: "Authentication required" });
  }
  await ensurePaymentTransactionsSchema();
  const { rows } = await query<PaymentTransactionRow>(
    `SELECT *
     FROM payment_transactions
     WHERE reference = $1
     LIMIT 1`,
    [req.params.reference],
  );
  const payment = rows[0];
  if (!payment) {
    return res.status(404).json({ ok: false, message: "Payment reference was not found." });
  }
  if (!userCanReadPayment(user, payment)) {
    return res.status(403).json({ ok: false, message: "Not authorized" });
  }
  return res.json({ ok: true, payment: publicPayment(payment) });
});

router.post("/webhook/transfer", async (req: Request, res: Response) => {
  if (!verifyTransferWebhookSignature(req)) {
    req.log.warn("Invalid payment transfer webhook signature");
    return res.status(401).json({ ok: false, message: "Invalid signature" });
  }

  const body = (req.body || {}) as Record<string, unknown>;
  if (!isSuccessfulPaymentStatus(body.status || body.event || body.paymentStatus)) {
    return res.json({ ok: true, ignored: true });
  }

  const reference =
    typeof body.reference === "string"
      ? body.reference.trim()
      : typeof body.paymentReference === "string"
        ? body.paymentReference.trim()
        : "";
  const amountKobo = readWebhookAmountKobo(body);
  const currency =
    typeof body.currency === "string" && body.currency.trim()
      ? body.currency.trim().toUpperCase()
      : paymentCurrency();

  if (!reference || amountKobo <= 0) {
    return res.status(400).json({ ok: false, message: "reference and amount are required" });
  }

  try {
    const result = await finalizeAutomaticPayment({
      reference,
      amountKobo,
      currency,
      providerPayload: body,
      log: req.log,
    });
    return res.json({
      ok: true,
      payment: publicPayment(result.payment),
      orderId: result.payment.order_id,
    });
  } catch (err) {
    if (err instanceof CheckoutOrderError) {
      return res.status(err.status).json({ ok: false, message: err.message });
    }
    req.log.error({ err, reference }, "Payment transfer webhook failed");
    throw err;
  }
});

router.post("/webhook/card", async (req: Request, res: Response) => {
  if (!verifyCardWebhookSignature(req)) {
    req.log.warn("Invalid card payment webhook signature");
    return res.status(401).json({ ok: false, message: "Invalid signature" });
  }

  const body = (req.body || {}) as Record<string, unknown>;
  if (!isSuccessfulPaymentStatus(body.status || body.event || body.paymentStatus)) {
    return res.json({ ok: true, ignored: true });
  }

  const reference =
    typeof body.reference === "string"
      ? body.reference.trim()
      : typeof body.paymentReference === "string"
        ? body.paymentReference.trim()
        : "";
  const amountKobo = readWebhookAmountKobo(body);
  const currency =
    typeof body.currency === "string" && body.currency.trim()
      ? body.currency.trim().toUpperCase()
      : paymentCurrency();

  if (!reference || amountKobo <= 0) {
    return res.status(400).json({ ok: false, message: "reference and amountKobo are required" });
  }

  try {
    const result = await finalizeAutomaticPayment({
      reference,
      amountKobo,
      currency,
      providerPayload: body,
      log: req.log,
    });
    return res.json({
      ok: true,
      payment: publicPayment(result.payment),
      orderId: result.payment.order_id,
    });
  } catch (err) {
    if (err instanceof CheckoutOrderError) {
      return res.status(err.status).json({ ok: false, message: err.message });
    }
    req.log.error({ err, reference }, "Card payment webhook failed");
    throw err;
  }
});

export default router;
