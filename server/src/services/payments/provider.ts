export type HostedPaymentMethod = "bank_transfer" | "card";

export type PaymentProviderStatus = "pending" | "paid" | "failed" | "expired";

export type PaymentProviderUser = {
  id: string;
  name: string;
  email: string;
};

export type ProviderPaymentResult = {
  checkoutUrl: string;
  providerReference: string;
  providerData: Record<string, unknown>;
};

export type ProviderVerification = {
  status: PaymentProviderStatus;
  amountKobo: number;
  currency: string;
  paymentReference: string;
  providerReference: string;
  paymentMethod?: string;
  providerData: Record<string, unknown>;
};

export type ProviderWebhook = {
  eventType: string;
  paymentReference: string;
  providerReference: string;
  refundReference?: string;
  payoutReference?: string;
  body: Record<string, unknown>;
};

export type ProviderRefundResult = {
  providerReference: string;
  status: "pending" | "completed" | "failed";
  amountKobo: number;
  providerData: Record<string, unknown>;
};

export type ProviderRefundVerification = ProviderRefundResult;

export type VerifiedBankAccount = {
  accountName: string;
  accountNumber: string;
  bankCode: string;
  providerData: Record<string, unknown>;
};

export type ProviderPayoutResult = {
  providerReference: string;
  status: "pending" | "authorization_required" | "completed" | "failed";
  amountKobo: number;
  currency: string;
  providerData: Record<string, unknown>;
};

export type ProviderPayoutVerification = ProviderPayoutResult;

export interface HostedPaymentProvider {
  readonly id: string;
  initialize(input: {
    reference: string;
    totalKobo: number;
    currency: string;
    method: HostedPaymentMethod;
    user: PaymentProviderUser;
    itemCount: number;
  }): Promise<ProviderPaymentResult>;
  verify(input: {
    paymentReference: string;
    providerReference?: string | null;
  }): Promise<ProviderVerification | null>;
  verifyWebhook(input: { rawBody: Buffer; signature: string | undefined }): boolean;
  parseWebhook(body: Record<string, unknown>): ProviderWebhook;
  refund(input: {
    transactionReference: string;
    refundReference: string;
    amountKobo: number;
    reason: string;
  }): Promise<ProviderRefundResult>;
  verifyRefund(input: {
    refundReference: string;
  }): Promise<ProviderRefundVerification | null>;
  validateBankAccount(input: {
    accountNumber: string;
    bankCode: string;
  }): Promise<VerifiedBankAccount>;
  payout(input: {
    reference: string;
    amountKobo: number;
    currency: string;
    narration: string;
    accountNumber: string;
    bankCode: string;
    accountName: string;
  }): Promise<ProviderPayoutResult>;
  verifyPayout(input: {
    merchantReference: string;
  }): Promise<ProviderPayoutVerification | null>;
}
