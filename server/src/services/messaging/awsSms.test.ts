import assert from "node:assert/strict";
import test from "node:test";
import type { PinpointSMSVoiceV2Client } from "@aws-sdk/client-pinpoint-sms-voice-v2";

process.env.AWS_REGION = "eu-west-1";
process.env.AWS_SMS_ORIGINATION_IDENTITY = "QuickServe";
process.env.AWS_SMS_CONFIGURATION_SET = "quickserve-auth";

test("sends a transactional OTP through AWS without exposing it outside the message body", async () => {
  let input: Record<string, unknown> | undefined;
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      input = command.input;
      return { MessageId: "message-123" };
    },
  } as unknown as PinpointSMSVoiceV2Client;
  const { AwsSmsProvider } = await import("./awsSms");
  const result = await new AwsSmsProvider(client).sendOtp({
    phoneE164: "+2348012345678",
    code: "123456",
    channel: "sms",
    purpose: "signup",
  });

  assert.equal(result.messageId, "message-123");
  assert.equal(input?.DestinationPhoneNumber, "+2348012345678");
  assert.equal(input?.OriginationIdentity, "QuickServe");
  assert.equal(input?.MessageType, "TRANSACTIONAL");
  assert.equal(input?.ConfigurationSetName, "quickserve-auth");
  assert.equal(input?.TimeToLive, 300);
  assert.match(String(input?.MessageBody), /123456/);
});
