import { createHmac, timingSafeEqual } from "crypto";
import { Router, Request, Response } from "express";
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
const PAYSTACK_BASE_URL = "https://api.paystack.co";

type PaymentTransactionRow = {
  id: string;
  reference: string;
  user_id: string;
  order_id: string | null;
  amount_kobo: number;
  currency: string;
  status: string;
  items: unknown;
};

type PaystackInitializeResponse = {
  status: boolean;
  message: string;
  data?: {
    authorization_url?: string;
    access_code?: string;
    reference?: string;
  };
};

type PaystackVerifyResponse = {
  status: boolean;
  message: string;
  data?: Record<string, any>;
};

function paystackSecret(): string {
  return process.env.PAYSTACK_SECRET_KEY?.trim() || "";
}

function paystackCurrency(): string {
  return (process.env.PAYSTACK_CURRENCY || "NGN").trim().toUpperCase();
}

function paystackCallbackUrl(): string | undefined {
  const configured = process.env.PAYSTACK_CALLBACK_URL?.trim();
  if (configured) return configured;
  const scheme = process.env.APP_DEEP_LINK_SCHEME?.trim();
  return scheme ? `${scheme}://paystack/complete` : undefined;
}

async function ensurePaymentTransactionsTable(client: { query: Function }): Promise<void> {
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
      access_code TEXT,
      authorization_url TEXT,
      paystack_transaction_id TEXT,
      paystack_domain TEXT,
      paystack_channel TEXT,
      gateway_response TEXT,
      paystack_response JSONB,
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      initialized_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      verified_at TIMESTAMPTZ
    )
  `);
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS access_code TEXT");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS authorization_url TEXT");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS paystack_transaction_id TEXT");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS paystack_domain TEXT");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS paystack_channel TEXT");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS gateway_response TEXT");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS paystack_response JSONB");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS failure_reason TEXT");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS initialized_at TIMESTAMPTZ");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ");
  await client.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ");
  await client.query("CREATE INDEX IF NOT EXISTS idx_payment_transactions_user_created ON payment_transactions (user_id, created_at DESC)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON payment_transactions (status, created_at DESC)");
}

function publicPayment(row: PaymentTransactionRow) {
  return {
    reference: row.reference,
    orderId: row.order_id,
    amountKobo: row.amount_kobo,
    currency: row.currency,
    status: row.status,
  };
}

async function callPaystack<T>(path: string, init: RequestInit): Promise<T> {
  const secret = paystackSecret();
  if (!secret) {
    throw new CheckoutOrderError(503, "Paystack is not configured on the server.");
  }

  const response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const payload = (await response.json().catch(() => null)) as T & { message?: string };
  if (!response.ok) {
    throw new CheckoutOrderError(
      response.status >= 500 ? 502 : 400,
      payload?.message || "Paystack request failed.",
    );
  }
  return payload;
}

function getPaystackDataValue(data: Record<string, any>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function validateSuccessfulPaystackData(
  payment: PaymentTransactionRow,
  data: Record<string, any> | undefined,
): { ok: true } | { ok: false; message: string } {
  if (!data || typeof data !== "object") {
    return { ok: false, message: "Missing Paystack verification data." };
  }
  if (getPaystackDataValue(data, "reference") !== payment.reference) {
    return { ok: false, message: "Payment reference mismatch." };
  }
  if (getPaystackDataValue(data, "status").toLowerCase() !== "success") {
    return { ok: false, message: "Payment was not successful." };
  }
  if (Number(data.amount) !== Number(payment.amount_kobo)) {
    return { ok: false, message: "Payment amount mismatch." };
  }
  if (getPaystackDataValue(data, "currency").toUpperCase() !== payment.currency.toUpperCase()) {
    return { ok: false, message: "Payment currency mismatch." };
  }
  return { ok: true };
}

async function finalizeSuccessfulPayment(
  reference: string,
  paystackData: Record<string, any>,
  log: Request["log"],
  expectedUserId?: string,
): Promise<{ orderId: string; payment: PaymentTransactionRow; createdOrder: boolean }> {
  let notificationPayload: { orderId: string; userId: string; items: Record<string, any>[] } | null = null;

  const result = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await ensurePaymentTransactionsTable(client);
      const { rows } = await client.query<PaymentTransactionRow>(
        `SELECT id, reference, user_id, order_id, amount_kobo, currency, status, items
         FROM payment_transactions
         WHERE reference = $1
         FOR UPDATE`,
        [reference],
      );
      const payment = rows[0];
      if (!payment) {
        throw new CheckoutOrderError(404, "Payment reference was not found.");
      }
      if (expectedUserId && payment.user_id !== expectedUserId) {
        throw new CheckoutOrderError(403, "This payment belongs to another user.");
      }
      if (payment.order_id) {
        await client.query("COMMIT");
        return { orderId: payment.order_id, payment, createdOrder: false };
      }

      const validation = validateSuccessfulPaystackData(payment, paystackData);
      if (!validation.ok) {
        await client.query(
          `UPDATE payment_transactions
           SET status = 'verification_failed',
               failure_reason = $2,
               paystack_response = $3::jsonb,
               verified_at = NOW(),
               updated_at = NOW()
           WHERE reference = $1`,
          [payment.reference, validation.message, JSON.stringify(paystackData)],
        );
        throw new CheckoutOrderError(402, validation.message);
      }

      const items = Array.isArray(payment.items)
        ? (payment.items as Record<string, any>[])
        : [];
      const order = await insertOrderForCheckout(client, {
        userId: payment.user_id,
        items,
      });

      const updated = await client.query<PaymentTransactionRow>(
        `UPDATE payment_transactions
         SET status = 'paid',
             order_id = $2,
             paystack_transaction_id = $3,
             paystack_domain = $4,
             paystack_channel = $5,
             gateway_response = $6,
             paystack_response = $7::jsonb,
             paid_at = COALESCE($8::timestamptz, NOW()),
             verified_at = NOW(),
             updated_at = NOW()
         WHERE reference = $1
         RETURNING id, reference, user_id, order_id, amount_kobo, currency, status, items`,
        [
          payment.reference,
          order.id,
          dataNumberOrString(paystackData.id),
          getPaystackDataValue(paystackData, "domain"),
          getPaystackDataValue(paystackData, "channel"),
          getPaystackDataValue(paystackData, "gateway_response"),
          JSON.stringify(paystackData),
          getPaystackDataValue(paystackData, "paid_at") || null,
        ],
      );

      notificationPayload = {
        orderId: order.id,
        userId: payment.user_id,
        items,
      };
      await client.query("COMMIT");
      return {
        orderId: order.id,
        payment: updated.rows[0] || payment,
        createdOrder: true,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });

  if (notificationPayload) {
    await notifyOrderCreated(log, notificationPayload);
  }

  return result;
}

function dataNumberOrString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value : "";
}

router.post("/paystack/initialize", requireAuthenticated, async (req: Request, res: Response) => {
  const user = req.user;
  const log = req.log;
  if (!user) {
    return res.status(401).json({ ok: false, message: "Authentication required" });
  }
  if (!paystackSecret()) {
    return res.status(503).json({ ok: false, message: "Paystack is not configured on the server." });
  }

  const rawItems = Array.isArray((req.body as { items?: unknown[] })?.items)
    ? (req.body as { items: unknown[] }).items
    : [];

  try {
    const setup = await withClient(async (client) => {
      await ensurePaymentTransactionsTable(client);
      const items = await normalizeCheckoutItems(client, user.id, rawItems);
      const amountKobo = calculateCheckoutAmountKobo(items);
      const currency = paystackCurrency();
      const reference = genCheckoutId("sph_pay");
      const userResult = await client.query<{ email: string; first_name: string | null; last_name: string | null }>(
        "SELECT email, first_name, last_name FROM users WHERE id = $1 LIMIT 1",
        [user.id],
      );
      const profile = userResult.rows[0];
      if (!profile?.email) {
        throw new CheckoutOrderError(404, "User email was not found.");
      }

      await client.query(
        `INSERT INTO payment_transactions
           (id, reference, user_id, amount_kobo, currency, status, items)
         VALUES ($1, $2, $3, $4, $5, 'initializing', $6::jsonb)`,
        [genCheckoutId("pay"), reference, user.id, amountKobo, currency, JSON.stringify(items)],
      );

      return { items, amountKobo, currency, reference, profile };
    });

    const callbackUrl = paystackCallbackUrl();
    const response = await callPaystack<PaystackInitializeResponse>("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email: setup.profile.email,
        amount: setup.amountKobo,
        currency: setup.currency,
        reference: setup.reference,
        ...(callbackUrl ? { callback_url: callbackUrl } : {}),
        metadata: {
          userId: user.id,
          source: "spare_parts_hub_mobile",
          itemCount: setup.items.length,
          firstName: setup.profile.first_name,
          lastName: setup.profile.last_name,
        },
      }),
    });

    const authorizationUrl = response.data?.authorization_url;
    const accessCode = response.data?.access_code;
    const returnedReference = response.data?.reference || setup.reference;
    if (!response.status || !authorizationUrl || !accessCode || returnedReference !== setup.reference) {
      throw new CheckoutOrderError(502, response.message || "Paystack did not return a checkout URL.");
    }

    await query(
      `UPDATE payment_transactions
       SET status = 'initialized',
           access_code = $2,
           authorization_url = $3,
           paystack_response = $4::jsonb,
           initialized_at = NOW(),
           updated_at = NOW()
       WHERE reference = $1`,
      [setup.reference, accessCode, authorizationUrl, JSON.stringify(response)],
    );

    log.info({ reference: setup.reference, userId: user.id }, "Paystack checkout initialized");
    return res.status(201).json({
      ok: true,
      reference: setup.reference,
      authorizationUrl,
      accessCode,
      amountKobo: setup.amountKobo,
      currency: setup.currency,
    });
  } catch (err) {
    if (err instanceof CheckoutOrderError) {
      return res.status(err.status).json({ ok: false, message: err.message });
    }
    log.error({ err, userId: user.id }, "Paystack initialize failed");
    throw err;
  }
});

router.post("/paystack/verify/:reference", requireAuthenticated, async (req: Request, res: Response) => {
  const user = req.user;
  const { reference } = req.params;
  const log = req.log;
  if (!user) {
    return res.status(401).json({ ok: false, message: "Authentication required" });
  }

  try {
    const existing = await query<PaymentTransactionRow>(
      `SELECT id, reference, user_id, order_id, amount_kobo, currency, status, items
       FROM payment_transactions
       WHERE reference = $1
       LIMIT 1`,
      [reference],
    );
    const payment = existing.rows[0];
    if (!payment) {
      return res.status(404).json({ ok: false, message: "Payment reference was not found." });
    }
    if (payment.user_id !== user.id) {
      return res.status(403).json({ ok: false, message: "This payment belongs to another user." });
    }
    if (payment.order_id) {
      return res.json({ ok: true, orderId: payment.order_id, payment: publicPayment(payment) });
    }

    const verification = await callPaystack<PaystackVerifyResponse>(
      `/transaction/verify/${encodeURIComponent(reference)}`,
      { method: "GET" },
    );
    const result = await finalizeSuccessfulPayment(reference, verification.data || {}, log, user.id);
    return res.json({
      ok: true,
      orderId: result.orderId,
      payment: publicPayment(result.payment),
    });
  } catch (err) {
    if (err instanceof CheckoutOrderError) {
      return res.status(err.status).json({ ok: false, message: err.message });
    }
    log.error({ err, reference, userId: user.id }, "Paystack verify failed");
    throw err;
  }
});

router.post("/paystack/webhook", async (req: Request, res: Response) => {
  const secret = paystackSecret();
  if (!secret) {
    return res.status(503).json({ ok: false, message: "Paystack is not configured on the server." });
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const bodyBuffer = rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expected = createHmac("sha512", secret).update(bodyBuffer).digest("hex");
  const actual = String(req.header("x-paystack-signature") || "");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  if (
    !actual ||
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    req.log.warn("Invalid Paystack webhook signature");
    return res.status(401).json({ ok: false, message: "Invalid signature" });
  }

  const event = req.body as { event?: string; data?: Record<string, any> };
  if (event.event === "charge.success") {
    const reference = getPaystackDataValue(event.data || {}, "reference");
    if (reference) {
      await finalizeSuccessfulPayment(reference, event.data || {}, req.log).catch((err) => {
        req.log.error({ err, reference }, "Paystack webhook processing failed");
        throw err;
      });
    }
  }

  return res.json({ ok: true });
});

export default router;
