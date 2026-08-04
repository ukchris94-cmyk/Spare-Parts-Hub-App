import { CheckoutOrderError } from "../orderCheckout";
import { env } from "../../config/env";
import { MonnifyProvider } from "./monnify";
import { HostedPaymentProvider } from "./provider";

const providers = new Map<string, HostedPaymentProvider>([
  ["monnify", new MonnifyProvider()],
]);

export function getPaymentProvider(name = process.env.PAYMENT_PROVIDER || "monnify"): HostedPaymentProvider {
  if (!env.PAYMENTS_ENABLED) {
    throw new CheckoutOrderError(503, "Payments are temporarily unavailable.");
  }
  const normalized = name.trim().toLowerCase();
  const provider = providers.get(normalized);
  if (!provider) {
    throw new CheckoutOrderError(503, `Payment provider '${normalized}' is not configured.`);
  }
  return provider;
}

export * from "./provider";
