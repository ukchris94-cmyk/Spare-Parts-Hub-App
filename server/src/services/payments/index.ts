import { CheckoutOrderError } from "../orderCheckout";
import { MonnifyProvider } from "./monnify";
import { HostedPaymentProvider } from "./provider";

const providers = new Map<string, HostedPaymentProvider>([
  ["monnify", new MonnifyProvider()],
]);

export function getPaymentProvider(name = process.env.PAYMENT_PROVIDER || "monnify"): HostedPaymentProvider {
  const normalized = name.trim().toLowerCase();
  const provider = providers.get(normalized);
  if (!provider) {
    throw new CheckoutOrderError(503, `Payment provider '${normalized}' is not configured.`);
  }
  return provider;
}

export * from "./provider";

