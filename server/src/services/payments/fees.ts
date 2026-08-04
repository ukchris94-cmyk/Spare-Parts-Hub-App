export type PaymentBreakdown = {
  subtotalKobo: number;
  platformFeeKobo: number;
  taxKobo: number;
  totalKobo: number;
  currency: string;
};

export function calculatePaymentBreakdown(
  subtotalKobo: number,
  options: { platformFeeBps: number; taxBps: number; currency: string }
): PaymentBreakdown {
  if (!Number.isSafeInteger(subtotalKobo) || subtotalKobo <= 0) {
    throw new Error("Subtotal must be a positive integer in the currency's minor unit");
  }
  if (
    !Number.isInteger(options.platformFeeBps) ||
    options.platformFeeBps < 0 ||
    options.platformFeeBps > 10_000 ||
    !Number.isInteger(options.taxBps) ||
    options.taxBps < 0 ||
    options.taxBps > 10_000
  ) {
    throw new Error("Fee and tax rates must be between 0 and 10,000 basis points");
  }
  const platformFeeKobo = Math.ceil((subtotalKobo * options.platformFeeBps) / 10_000);
  const taxKobo = Math.ceil((subtotalKobo * options.taxBps) / 10_000);
  return {
    subtotalKobo,
    platformFeeKobo,
    taxKobo,
    totalKobo: subtotalKobo + platformFeeKobo + taxKobo,
    currency: options.currency.trim().toUpperCase(),
  };
}
