import { createHmac } from "crypto";
import { env } from "../../config/env";
import { CheckoutOrderError } from "../orderCheckout";

export function paymentEmailForUser(userId: string, accountEmail: string | null): string {
  if (accountEmail?.trim()) return accountEmail.trim().toLowerCase();
  if (!env.MONNIFY_RELAY_EMAIL_APPROVED) {
    throw new CheckoutOrderError(503, "Phone-only checkout is awaiting Monnify relay-email approval.");
  }
  const domain = env.PAYMENT_RELAY_EMAIL_DOMAIN?.trim().toLowerCase();
  const secret = env.PAYMENT_RELAY_EMAIL_SECRET?.trim();
  if (!domain || !secret || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    throw new CheckoutOrderError(503, "Payment relay email is not configured.");
  }
  const token = createHmac("sha256", secret).update(`monnify:${userId}`).digest("base64url").slice(0, 32);
  return `payments+${token}@${domain}`;
}
