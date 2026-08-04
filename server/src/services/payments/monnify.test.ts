import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

process.env.MONNIFY_BASE_URL = "https://sandbox.monnify.test";
process.env.MONNIFY_API_KEY = "test-api-key";
process.env.MONNIFY_SECRET_KEY = "test-secret-key";
process.env.MONNIFY_CONTRACT_CODE = "test-contract";
process.env.MONNIFY_REDIRECT_URL = "https://backend.quickserve.com.ng/api/payments/return/monnify";

test("accepts only an exact HMAC-SHA512 Monnify signature", async () => {
  const { MonnifyProvider } = await import("./monnify");
  const provider = new MonnifyProvider();
  const rawBody = Buffer.from('{"eventType":"SUCCESSFUL_TRANSACTION"}');
  const signature = createHmac("sha512", "test-secret-key").update(rawBody).digest("hex");

  assert.equal(provider.verifyWebhook({ rawBody, signature }), true);
  assert.equal(provider.verifyWebhook({ rawBody, signature: `${signature.slice(0, -1)}0` }), false);
  assert.equal(provider.verifyWebhook({ rawBody, signature: undefined }), false);
});

test("parses payment, refund, and payout references without trusting extra fields", async () => {
  const { MonnifyProvider } = await import("./monnify");
  const event = new MonnifyProvider().parseWebhook({
    eventType: "SUCCESSFUL_DISBURSEMENT",
    eventData: {
      paymentReference: "QS-payment",
      transactionReference: "provider-reference",
      refundReference: "refund-reference",
      reference: "payout-reference",
    },
  });
  assert.equal(event.paymentReference, "QS-payment");
  assert.equal(event.providerReference, "provider-reference");
  assert.equal(event.refundReference, "refund-reference");
  assert.equal(event.payoutReference, "payout-reference");
});
