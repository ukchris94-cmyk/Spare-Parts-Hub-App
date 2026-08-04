import { createHmac, timingSafeEqual } from "crypto";
import { CheckoutOrderError } from "../orderCheckout";
import {
  HostedPaymentMethod,
  HostedPaymentProvider,
  ProviderPayoutResult,
  ProviderPayoutVerification,
  ProviderRefundResult,
  ProviderRefundVerification,
  ProviderVerification,
  ProviderWebhook,
  VerifiedBankAccount,
} from "./provider";

type Envelope<T> = {
  requestSuccessful?: boolean;
  responseMessage?: string;
  responseCode?: string;
  responseBody?: T;
};

type AuthBody = { accessToken?: string; expiresIn?: number };
type InitializeBody = {
  checkoutUrl?: string;
  transactionReference?: string;
  paymentReference?: string;
};
type VerifyBody = {
  paymentReference?: string;
  transactionReference?: string;
  paymentStatus?: string;
  amountPaid?: number | string;
  totalPayable?: number | string;
  currencyCode?: string;
  currency?: string;
  paymentMethod?: string;
};
type RefundBody = {
  refundReference?: string;
  refundStatus?: string;
  transactionReference?: string;
  refundAmount?: number | string;
  refundType?: string;
  comment?: string;
};
type AccountValidationBody = {
  accountNumber?: string;
  accountName?: string;
  bankCode?: string;
};
type PayoutBody = {
  reference?: string;
  status?: string;
  transactionReference?: string;
  transactionDescription?: string;
  amount?: number | string;
  fee?: number | string;
  currency?: string;
};

let tokenCache: { token: string; expiresAtMs: number } | null = null;

function config() {
  const apiKey = process.env.MONNIFY_API_KEY?.trim();
  const secretKey = process.env.MONNIFY_SECRET_KEY?.trim();
  const contractCode = process.env.MONNIFY_CONTRACT_CODE?.trim();
  const redirectUrl = process.env.MONNIFY_REDIRECT_URL?.trim();
  const configuredBaseUrl = process.env.MONNIFY_BASE_URL?.trim();
  const baseUrl = (configuredBaseUrl || "https://sandbox.monnify.com").replace(/\/+$/, "");

  if (process.env.NODE_ENV === "production" && !configuredBaseUrl) {
    throw new CheckoutOrderError(503, "MONNIFY_BASE_URL is not configured.");
  }
  if (!apiKey || !secretKey || !contractCode || !redirectUrl) {
    throw new CheckoutOrderError(503, "Monnify checkout is not configured.");
  }
  if (process.env.NODE_ENV === "production" && !redirectUrl.startsWith("https://")) {
    throw new CheckoutOrderError(503, "MONNIFY_REDIRECT_URL must use HTTPS in production.");
  }
  return { apiKey, secretKey, contractCode, redirectUrl, baseUrl };
}

async function request<T>(url: string, init: RequestInit): Promise<{ response: Response; payload: Envelope<T> | null }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => null)) as Envelope<T> | null;
  return { response, payload };
}

async function accessToken(): Promise<string> {
  const settings = config();
  if (tokenCache && tokenCache.expiresAtMs > Date.now() + 60_000) return tokenCache.token;

  const { response, payload } = await request<AuthBody>(`${settings.baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${settings.apiKey}:${settings.secretKey}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
  });
  const token = payload?.responseBody?.accessToken;
  if (!response.ok || !token) {
    throw new CheckoutOrderError(
      response.status >= 500 ? 502 : 503,
      payload?.responseMessage || "Could not authenticate with the payment provider."
    );
  }
  const expiresIn = payload?.responseBody?.expiresIn || 3600;
  tokenCache = { token, expiresAtMs: Date.now() + Math.max(60, expiresIn - 60) * 1000 };
  return token;
}

function toKobo(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : 0;
}

function status(value: unknown): ProviderVerification["status"] {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (normalized === "PAID") return "paid";
  if (normalized === "EXPIRED") return "expired";
  if (["FAILED", "REVERSED", "PARTIALLY_PAID"].includes(normalized)) return "failed";
  return "pending";
}

function refundStatus(value: unknown): ProviderRefundResult["status"] {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (normalized === "COMPLETED") return "completed";
  if (normalized === "FAILED") return "failed";
  return "pending";
}

function payoutStatus(value: unknown): ProviderPayoutResult["status"] {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (["SUCCESS", "SUCCESSFUL", "COMPLETED"].includes(normalized)) return "completed";
  if (normalized === "PENDING_AUTHORIZATION") return "authorization_required";
  if (["FAILED", "REVERSED", "EXPIRED"].includes(normalized)) return "failed";
  return "pending";
}

function sanitizeVerification(body: VerifyBody): Record<string, unknown> {
  return {
    paymentReference: body.paymentReference,
    transactionReference: body.transactionReference,
    paymentStatus: body.paymentStatus,
    amountPaid: body.amountPaid,
    totalPayable: body.totalPayable,
    currencyCode: body.currencyCode || body.currency,
    paymentMethod: body.paymentMethod,
  };
}

export class MonnifyProvider implements HostedPaymentProvider {
  readonly id = "monnify";

  async initialize(input: {
    reference: string;
    totalKobo: number;
    currency: string;
    method: HostedPaymentMethod;
    user: { id: string; name: string; email: string };
    itemCount: number;
  }) {
    const settings = config();
    const token = await accessToken();
    const { response, payload } = await request<InitializeBody>(
      `${settings.baseUrl}/api/v1/merchant/transactions/init-transaction`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: input.totalKobo / 100,
          paymentReference: input.reference,
          paymentDescription: `QuickServe ${input.method === "card" ? "card" : "bank transfer"} checkout`,
          currencyCode: input.currency,
          contractCode: settings.contractCode,
          redirectUrl: settings.redirectUrl,
          customerName: input.user.name || "QuickServe customer",
          customerEmail: input.user.email,
          paymentMethods: [input.method === "card" ? "CARD" : "ACCOUNT_TRANSFER"],
          metaData: {
            userId: input.user.id,
            itemCount: input.itemCount,
            source: "quickserve_mobile",
            paymentMethod: input.method,
          },
        }),
      }
    );
    const body = payload?.responseBody;
    if (!response.ok || !body?.checkoutUrl) {
      throw new CheckoutOrderError(
        response.status >= 500 ? 502 : 400,
        payload?.responseMessage || "Payment checkout initialization failed."
      );
    }
    const providerReference = body.transactionReference || body.paymentReference || "";
    return {
      checkoutUrl: body.checkoutUrl,
      providerReference,
      providerData: {
        responseCode: payload?.responseCode,
        paymentReference: body.paymentReference || input.reference,
        transactionReference: body.transactionReference,
      },
    };
  }

  async verify(input: { paymentReference: string; providerReference?: string | null }) {
    const settings = config();
    const token = await accessToken();
    const urls = input.providerReference
      ? [
          `${settings.baseUrl}/api/v2/transactions/${encodeURIComponent(input.providerReference)}`,
          `${settings.baseUrl}/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(input.paymentReference)}`,
        ]
      : [
          `${settings.baseUrl}/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(input.paymentReference)}`,
        ];

    for (const url of urls) {
      const { response, payload } = await request<VerifyBody>(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const body = payload?.responseBody;
      if (response.ok && body) {
        const paymentReference = String(body.paymentReference || "").trim();
        if (!paymentReference || paymentReference !== input.paymentReference) continue;
        return {
          status: status(body.paymentStatus),
          amountKobo: toKobo(body.amountPaid ?? body.totalPayable),
          currency: String(body.currencyCode || body.currency || "NGN").toUpperCase(),
          paymentReference,
          providerReference: body.transactionReference || input.providerReference || "",
          paymentMethod: body.paymentMethod,
          providerData: sanitizeVerification(body),
        } satisfies ProviderVerification;
      }
    }
    return null;
  }

  verifyWebhook(input: { rawBody: Buffer; signature: string | undefined }): boolean {
    const settings = config();
    if (!input.signature) {
      return (
        process.env.NODE_ENV !== "production" &&
        process.env.MONNIFY_ALLOW_UNSIGNED_SANDBOX_WEBHOOKS === "true"
      );
    }
    const expected = createHmac("sha512", settings.secretKey)
      .update(input.rawBody)
      .digest("hex");
    const supplied = input.signature.trim().toLowerCase();
    const expectedBuffer = Buffer.from(expected, "hex");
    const suppliedBuffer = /^[a-f0-9]{128}$/.test(supplied)
      ? Buffer.from(supplied, "hex")
      : Buffer.alloc(0);
    return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
  }

  parseWebhook(body: Record<string, unknown>): ProviderWebhook {
    const eventData = body.eventData && typeof body.eventData === "object"
      ? (body.eventData as Record<string, unknown>)
      : body;
    return {
      eventType: typeof body.eventType === "string" ? body.eventType : "",
      paymentReference: typeof eventData.paymentReference === "string" ? eventData.paymentReference.trim() : "",
      providerReference: typeof eventData.transactionReference === "string" ? eventData.transactionReference.trim() : "",
      refundReference: typeof eventData.refundReference === "string" ? eventData.refundReference.trim() : undefined,
      payoutReference: typeof eventData.reference === "string" ? eventData.reference.trim() : undefined,
      body: eventData,
    };
  }

  async refund(input: {
    transactionReference: string;
    refundReference: string;
    amountKobo: number;
    reason: string;
  }): Promise<ProviderRefundResult> {
    const settings = config();
    const token = await accessToken();
    const { response, payload } = await request<RefundBody>(
      `${settings.baseUrl}/api/v1/refunds/initiate-refund`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          transactionReference: input.transactionReference,
          refundReference: input.refundReference,
          refundAmount: input.amountKobo / 100,
          refundReason: input.reason.slice(0, 64),
          customerNote: "QS order refund",
        }),
      }
    );
    const body = payload?.responseBody;
    if (!response.ok || !body) {
      throw new CheckoutOrderError(
        response.status >= 500 ? 502 : 409,
        payload?.responseMessage || "The refund could not be initiated."
      );
    }
    return {
      providerReference: body.refundReference || input.refundReference,
      status: refundStatus(body.refundStatus),
      amountKobo: toKobo(body.refundAmount),
      providerData: {
        refundReference: body.refundReference,
        transactionReference: body.transactionReference,
        refundAmount: body.refundAmount,
        refundType: body.refundType,
        refundStatus: body.refundStatus,
        comment: body.comment,
      },
    };
  }

  async verifyRefund(input: {
    refundReference: string;
  }): Promise<ProviderRefundVerification | null> {
    const settings = config();
    const token = await accessToken();
    const { response, payload } = await request<RefundBody>(
      `${settings.baseUrl}/api/v1/refunds/${encodeURIComponent(input.refundReference)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      }
    );
    const body = payload?.responseBody;
    if (!response.ok || !body) return null;
    const providerReference = String(body.refundReference || "").trim();
    if (!providerReference || providerReference !== input.refundReference) return null;
    return {
      providerReference,
      status: refundStatus(body.refundStatus),
      amountKobo: toKobo(body.refundAmount),
      providerData: {
        refundReference: providerReference,
        transactionReference: body.transactionReference,
        refundAmount: body.refundAmount,
        refundType: body.refundType,
        refundStatus: body.refundStatus,
        comment: body.comment,
      },
    };
  }

  async validateBankAccount(input: {
    accountNumber: string;
    bankCode: string;
  }): Promise<VerifiedBankAccount> {
    const settings = config();
    const token = await accessToken();
    const url = `${settings.baseUrl}/api/v2/disbursements/account/validate?accountNumber=${encodeURIComponent(input.accountNumber)}&bankCode=${encodeURIComponent(input.bankCode)}`;
    const { response, payload } = await request<AccountValidationBody>(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const body = payload?.responseBody;
    if (!response.ok || !body?.accountName || !body.accountNumber) {
      throw new CheckoutOrderError(
        response.status >= 500 ? 502 : 400,
        payload?.responseMessage || "The bank account could not be verified."
      );
    }
    return {
      accountName: body.accountName,
      accountNumber: body.accountNumber,
      bankCode: body.bankCode || input.bankCode,
      providerData: {
        accountName: body.accountName,
        bankCode: body.bankCode || input.bankCode,
        lastFour: body.accountNumber.slice(-4),
      },
    };
  }

  async payout(input: {
    reference: string;
    amountKobo: number;
    currency: string;
    narration: string;
    accountNumber: string;
    bankCode: string;
    accountName: string;
  }): Promise<ProviderPayoutResult> {
    if (process.env.MONNIFY_DISBURSEMENTS_ENABLED !== "true") {
      throw new CheckoutOrderError(503, "Monnify disbursements are not enabled.");
    }
    const sourceAccountNumber = process.env.MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT?.trim();
    if (!sourceAccountNumber) {
      throw new CheckoutOrderError(503, "MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT is not configured.");
    }
    const settings = config();
    const token = await accessToken();
    const { response, payload } = await request<PayoutBody>(
      `${settings.baseUrl}/api/v2/disbursements/single`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: input.amountKobo / 100,
          reference: input.reference,
          narration: input.narration.slice(0, 100),
          destinationBankCode: input.bankCode,
          destinationAccountNumber: input.accountNumber,
          destinationAccountName: input.accountName,
          currency: input.currency,
          sourceAccountNumber,
          async: true,
        }),
      }
    );
    const body = payload?.responseBody;
    if (!response.ok || !body) {
      throw new CheckoutOrderError(
        response.status >= 500 ? 502 : 409,
        payload?.responseMessage || "Vendor payout could not be initiated."
      );
    }
    return {
      providerReference: body.transactionReference || body.reference || input.reference,
      status: payoutStatus(body.status),
      amountKobo: toKobo(body.amount),
      currency: String(body.currency || input.currency).toUpperCase(),
      providerData: {
        reference: body.reference,
        transactionReference: body.transactionReference,
        status: body.status,
        transactionDescription: body.transactionDescription,
        amount: body.amount,
        fee: body.fee,
      },
    };
  }

  async verifyPayout(input: {
    merchantReference: string;
  }): Promise<ProviderPayoutVerification | null> {
    const settings = config();
    const token = await accessToken();
    const { response, payload } = await request<PayoutBody>(
      `${settings.baseUrl}/api/v2/disbursements/single/summary?reference=${encodeURIComponent(input.merchantReference)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      }
    );
    const body = payload?.responseBody;
    if (!response.ok || !body) return null;
    const reference = String(body.reference || "").trim();
    if (!reference || reference !== input.merchantReference) return null;
    return {
      providerReference: body.transactionReference || reference,
      status: payoutStatus(body.status),
      amountKobo: toKobo(body.amount),
      currency: String(body.currency || "NGN").toUpperCase(),
      providerData: {
        reference,
        transactionReference: body.transactionReference,
        status: body.status,
        transactionDescription: body.transactionDescription,
        amount: body.amount,
        fee: body.fee,
        currency: body.currency || "NGN",
      },
    };
  }
}
