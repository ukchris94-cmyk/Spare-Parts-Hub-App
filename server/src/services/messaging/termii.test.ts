import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

process.env.TERMII_SECRET_KEY = "test-termii-webhook-secret-value";

test("validates Termii delivery webhook signatures against the raw body", async () => {
  const { TermiiProvider } = await import("./termii");
  const provider = new TermiiProvider();
  const rawBody = Buffer.from(JSON.stringify({ message_id: "msg-1", status: "delivered" }));
  const signature = createHmac("sha512", process.env.TERMII_SECRET_KEY as string)
    .update(rawBody)
    .digest("hex");

  assert.equal(provider.verifyWebhook({ rawBody, signature }), true);
  assert.equal(provider.verifyWebhook({ rawBody: Buffer.from("tampered"), signature }), false);
  assert.equal(provider.verifyWebhook({ rawBody }), false);
});
