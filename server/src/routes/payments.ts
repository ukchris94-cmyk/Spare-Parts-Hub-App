import { createHash, createHmac, timingSafeEqual } from "crypto";
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
  failure_reason: string | null;
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

type MonnifyPaymentMethod = "ACCOUNT_TRANSFER" | "CARD";

type MonnifyCheckoutMethod = "bank_transfer" | "card";

type MonnifyEnvelope<T> = {
  requestSuccessful?: boolean;
  responseMessage?: string;
  responseCode?: string;
  responseBody?: T;
};

type MonnifyAuthBody = {
  accessToken?: string;
  expiresIn?: number;
};

type MonnifyInitBody = {
  checkoutUrl?: string;
  transactionReference?: string;
  paymentReference?: string;
};

type MonnifyVerifyBody = {
  paymentReference?: string;
  transactionReference?: string;
  paymentStatus?: string;
  amountPaid?: number | string;
  totalPayable?: number | string;
  settlementAmount?: number | string;
  currencyCode?: string;
  paymentMethod?: string;
};

let monnifyTokenCache: { token: string; expiresAtMs: number } | null = null;

function monnifyBaseUrl(): string {
  const configured = process.env.MONNIFY_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new CheckoutOrderError(503, "MONNIFY_BASE_URL is not configured on the server.");
  }
  return "https://sandbox.monnify.com";
}

function monnifyConfig() {
  const apiKey = process.env.MONNIFY_API_KEY?.trim();
  const secretKey = process.env.MONNIFY_SECRET_KEY?.trim();
  const contractCode = process.env.MONNIFY_CONTRACT_CODE?.trim();
  if (!apiKey || !secretKey || !contractCode) {
    throw new CheckoutOrderError(503, "Monnify checkout is not configured on the server.");
  }
  return {
    baseUrl: monnifyBaseUrl(),
    apiKey,
    secretKey,
    contractCode,
  };
}

function monnifyRedirectUrl(callbackUrl?: unknown): string {
  if (typeof callbackUrl === "string" && callbackUrl.trim()) {
    return callbackUrl.trim();
  }
  const configured = process.env.MONNIFY_REDIRECT_URL?.trim();
  if (configured) return configured;
  throw new CheckoutOrderError(503, "MONNIFY_REDIRECT_URL is not configured on the server.");
}

function monnifyMethodFor(method: MonnifyCheckoutMethod): MonnifyPaymentMethod {
  return method === "card" ? "CARD" : "ACCOUNT_TRANSFER";
}

function nairaFromKobo(kobo: number): number {
  return Math.round(kobo) / 100;
}

function koboFromNaira(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : 0;
}

function monnifyPaymentIsSuccessful(status: unknown): boolean {
  return typeof status === "string" && status.trim().toUpperCase() === "PAID";
}

function monnifyPaymentIsTerminalFailure(status: unknown): boolean {
  const normalized = typeof status === "string" ? status.trim().toUpperCase() : "";
  return ["FAILED", "REVERSED", "EXPIRED", "PARTIALLY_PAID"].includes(normalized);
}

async function parseJsonResponse<T>(response: globalThis.Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

async function getMonnifyAccessToken(): Promise<string> {
  const config = monnifyConfig();
  if (monnifyTokenCache && monnifyTokenCache.expiresAtMs > Date.now() + 60_000) {
    return monnifyTokenCache.token;
  }

  const basic = Buffer.from(`${config.apiKey}:${config.secretKey}`).toString("base64");
  const response = await fetch(`${config.baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
    },
  });
  const payload = await parseJsonResponse<MonnifyEnvelope<MonnifyAuthBody>>(response);
  const token = payload?.responseBody?.accessToken;
  if (!response.ok || !token) {
    throw new CheckoutOrderError(
      response.status >= 500 ? 502 : 503,
      payload?.responseMessage || "Could not authenticate with Monnify.",
    );
  }

  const expiresInSeconds = payload?.responseBody?.expiresIn || 3600;
  monnifyTokenCache = {
    token,
    expiresAtMs: Date.now() + Math.max(60, expiresInSeconds - 60) * 1000,
  };
  return token;
}

async function initializeMonnifyCheckout(input: {
  reference: string;
  totalKobo: number;
  currency: string;
  method: MonnifyCheckoutMethod;
  user: { id: string; name?: string | null; email?: string | null };
  itemCount: number;
  callbackUrl?: unknown;
}): Promise<{ checkoutUrl: string; providerReference: string; payload: Record<string, unknown> }> {
  const config = monnifyConfig();
  const accessToken = await getMonnifyAccessToken();
  const response = await fetch(`${config.baseUrl}/api/v1/merchant/transactions/init-transaction`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: nairaFromKobo(input.totalKobo),
      paymentReference: input.reference,
      paymentDescription:
        input.method === "card"
          ? "Spare Parts Hub card checkout"
          : "Spare Parts Hub bank transfer checkout",
      currencyCode: input.currency,
      contractCode: config.contractCode,
      redirectUrl: monnifyRedirectUrl(input.callbackUrl),
      customerName: input.user.name || "Spare Parts Hub Customer",
      customerEmail: input.user.email || `${input.user.id}@sparepartshub.local`,
      paymentMethods: [monnifyMethodFor(input.method)],
      metaData: {
        userId: input.user.id,
        itemCount: input.itemCount,
        source: "spare_parts_hub_mobile",
        paymentMethod: input.method,
      },
    }),
  });
  const payload = await parseJsonResponse<MonnifyEnvelope<MonnifyInitBody>>(response);
  const body = payload?.responseBody;
  const checkoutUrl = body?.checkoutUrl || "";
  if (!response.ok || !checkoutUrl) {
    throw new CheckoutOrderError(
      response.status >= 500 ? 502 : 400,
      payload?.responseMessage || "Monnify checkout initialization failed.",
    );
  }

  return {
    checkoutUrl,
    providerReference: body?.transactionReference || body?.paymentReference || "",
    payload: (payload || {}) as Record<string, unknown>,
  };
}

async function verifyMonnifyPayment(input: {
  paymentReference: string;
  transactionReference?: string | null;
}): Promise<MonnifyVerifyBody | null> {
  const config = monnifyConfig();
  const accessToken = await getMonnifyAccessToken();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  const urls = input.transactionReference
    ? [
        `${config.baseUrl}/api/v2/transactions/${encodeURIComponent(input.transactionReference)}`,
        `${config.baseUrl}/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(input.paymentReference)}`,
      ]
    : [
        `${config.baseUrl}/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(input.paymentReference)}`,
      ];

  for (const url of urls) {
    const response = await fetch(url, { method: "GET", headers });
    const payload = await parseJsonResponse<MonnifyEnvelope<MonnifyVerifyBody>>(response);
    if (response.ok && payload?.responseBody) {
      return payload.responseBody;
    }
  }
  return null;
}

function verifyMonnifyWebhookSignature(req: Request): boolean {
  const secret = process.env.MONNIFY_SECRET_KEY?.trim();
  if (!secret) return false;
  const signature = req.header("monnify-signature") || "";
  if (!signature) {
    return process.env.NODE_ENV !== "production" && process.env.MONNIFY_ALLOW_UNSIGNED_SANDBOX_WEBHOOKS === "true";
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const bodyString = rawBody ? rawBody.toString("utf8") : JSON.stringify(req.body || {});
  const expected = createHash("sha512").update(`${secret}${bodyString}`).digest("hex");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function monnifyReferenceFromPayload(body: Record<string, any>): {
  paymentReference: string;
  transactionReference: string;
} {
  const eventData = body.eventData && typeof body.eventData === "object" ? body.eventData : body;
  const paymentReference =
    typeof eventData.paymentReference === "string"
      ? eventData.paymentReference.trim()
      : typeof body.paymentReference === "string"
        ? body.paymentReference.trim()
        : typeof body.reference === "string"
          ? body.reference.trim()
          : "";
  const transactionReference =
    typeof eventData.transactionReference === "string"
      ? eventData.transactionReference.trim()
      : typeof body.transactionReference === "string"
        ? body.transactionReference.trim()
        : "";
  return { paymentReference, transactionReference };
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

async function createMonnifyPendingCheckout(input: {
  user: { id: string; role: string };
  rawItems: unknown[];
  method: MonnifyCheckoutMethod;
  callbackUrl?: unknown;
}): Promise<PaymentTransactionRow> {
  const setup = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await ensurePaymentTransactionsTable(client);
      const items = await normalizeCheckoutItems(client, input.user.id, input.rawItems);
      const subtotalKobo = calculateCheckoutAmountKobo(items);
      const breakdown = calculateBreakdown(subtotalKobo);
      const expiresMinutes = paymentExpiryMinutes();
      const reference = buildPaymentReference();
      const status: PaymentStatus = input.method === "card" ? "awaiting_card" : "awaiting_transfer";
      const provider = "monnify";

      const { rows } = await client.query<PaymentTransactionRow>(
        `INSERT INTO payment_transactions
           (id, reference, user_id, amount_kobo, subtotal_kobo, platform_fee_kobo, tax_kobo,
            total_kobo, currency, status, provider, method, items, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $4, $8, $9, $10, $11, $12::jsonb,
                 NOW() + ($13::text || ' minutes')::interval)
         RETURNING *`,
        [
          genCheckoutId("pay"),
          reference,
          input.user.id,
          breakdown.totalKobo,
          breakdown.subtotalKobo,
          breakdown.platformFeeKobo,
          breakdown.taxKobo,
          breakdown.currency,
          status,
          provider,
          input.method,
          JSON.stringify(items),
          expiresMinutes,
        ],
      );

      await client.query("COMMIT");
      return { payment: rows[0], itemCount: items.length };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });

  const monnify = await initializeMonnifyCheckout({
    reference: setup.payment.reference,
    totalKobo: setup.payment.total_kobo ?? setup.payment.amount_kobo,
    currency: setup.payment.currency,
    method: input.method,
    user: input.user,
    itemCount: setup.itemCount,
    callbackUrl: input.callbackUrl,
  });

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
      monnify.checkoutUrl,
      monnify.providerReference || null,
      JSON.stringify(monnify.payload),
    ],
  );

  return updated.rows[0] || setup.payment;
}

async function refreshMonnifyPayment(payment: PaymentTransactionRow, log: Request["log"]): Promise<PaymentTransactionRow> {
  if (payment.provider !== "monnify" || payment.status === "paid" || payment.order_id) {
    return payment;
  }
  if (!["awaiting_transfer", "awaiting_card"].includes(payment.status)) {
    return payment;
  }

  const verified = await verifyMonnifyPayment({
    paymentReference: payment.reference,
    transactionReference: payment.provider_reference,
  });
  if (!verified) return payment;

  if (monnifyPaymentIsSuccessful(verified.paymentStatus)) {
    const result = await finalizeAutomaticPayment({
      reference: payment.reference,
      amountKobo: koboFromNaira(verified.amountPaid || verified.totalPayable),
      currency: verified.currencyCode || payment.currency,
      providerPayload: verified as Record<string, unknown>,
      log,
    });
    return result.payment;
  }

  if (monnifyPaymentIsTerminalFailure(verified.paymentStatus)) {
    const nextStatus: PaymentStatus = verified.paymentStatus === "EXPIRED" ? "expired" : "rejected";
    const updated = await query<PaymentTransactionRow>(
      `UPDATE payment_transactions
       SET status = $2,
           failure_reason = $3,
           provider_response = $4::jsonb,
           verified_at = NOW(),
           updated_at = NOW()
       WHERE reference = $1
         AND status IN ('awaiting_transfer', 'awaiting_card')
       RETURNING *`,
      [
        payment.reference,
        nextStatus,
        `Monnify payment status: ${verified.paymentStatus}`,
        JSON.stringify(verified),
      ],
    );
    return updated.rows[0] || payment;
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
      callbackUrl: req.body?.callbackUrl,
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
      callbackUrl: req.body?.callbackUrl,
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

router.post("/webhook/monnify", async (req: Request, res: Response) => {
  if (!verifyMonnifyWebhookSignature(req)) {
    req.log.warn("Invalid Monnify webhook signature");
    return res.status(401).json({ ok: false, message: "Invalid signature" });
  }

  const body = (req.body || {}) as Record<string, any>;
  const { paymentReference, transactionReference } = monnifyReferenceFromPayload(body);
  if (!paymentReference) {
    return res.status(400).json({ ok: false, message: "paymentReference is required" });
  }

  try {
    await ensurePaymentTransactionsSchema();
    const verified = await verifyMonnifyPayment({
      paymentReference,
      transactionReference,
    });
    if (!verified) {
      return res.status(404).json({ ok: false, message: "Monnify transaction was not found." });
    }

    if (!monnifyPaymentIsSuccessful(verified.paymentStatus)) {
      if (monnifyPaymentIsTerminalFailure(verified.paymentStatus)) {
        await query(
          `UPDATE payment_transactions
           SET status = $2,
               failure_reason = $3,
               provider_response = $4::jsonb,
               verified_at = NOW(),
               updated_at = NOW()
           WHERE reference = $1
             AND status IN ('awaiting_transfer', 'awaiting_card')`,
          [
            paymentReference,
            verified.paymentStatus === "EXPIRED" ? "expired" : "rejected",
            `Monnify payment status: ${verified.paymentStatus}`,
            JSON.stringify({ webhook: body, verified }),
          ],
        );
      }
      return res.json({ ok: true, ignored: true, status: verified.paymentStatus });
    }

    const result = await finalizeAutomaticPayment({
      reference: paymentReference,
      amountKobo: koboFromNaira(verified.amountPaid || verified.totalPayable),
      currency: verified.currencyCode || paymentCurrency(),
      providerPayload: { webhook: body, verified },
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
    req.log.error({ err, reference: paymentReference }, "Monnify webhook failed");
    throw err;
  }
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
