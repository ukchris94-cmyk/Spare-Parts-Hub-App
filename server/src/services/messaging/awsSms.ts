import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
} from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { env } from "../../config/env";
import { MessageChannel, MessageSendResult, MessagingProvider } from "./provider";

export class MessagingConfigurationError extends Error {}
export class MessagingDeliveryError extends Error {}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new MessagingConfigurationError(`${name} is not configured`);
  return normalized;
}

export class AwsSmsProvider implements MessagingProvider {
  readonly id = "aws_sms";
  private readonly client: PinpointSMSVoiceV2Client;

  constructor(client?: PinpointSMSVoiceV2Client) {
    this.client = client || new PinpointSMSVoiceV2Client({
      region: required(env.AWS_SMS_REGION || env.AWS_REGION, "AWS_SMS_REGION or AWS_REGION"),
    });
  }

  async sendOtp(input: {
    phoneE164: string;
    code: string;
    channel: MessageChannel;
    purpose: "signup" | "phone_migration" | "phone_change" | "password_reset";
  }): Promise<MessageSendResult> {
    if (input.channel !== "sms") {
      throw new MessagingDeliveryError("AWS SMS only supports the SMS channel");
    }

    const result = await this.client.send(new SendTextMessageCommand({
      DestinationPhoneNumber: input.phoneE164,
      OriginationIdentity: required(env.AWS_SMS_ORIGINATION_IDENTITY, "AWS_SMS_ORIGINATION_IDENTITY"),
      MessageBody: `Your QuickServe security code is ${input.code}. It expires in 5 minutes. Do not share it.`,
      MessageType: "TRANSACTIONAL",
      ConfigurationSetName: env.AWS_SMS_CONFIGURATION_SET,
      ProtectConfigurationId: env.AWS_SMS_PROTECT_CONFIGURATION_ID,
      TimeToLive: 300,
    }));

    if (!result.MessageId) {
      throw new MessagingDeliveryError("AWS accepted the request without returning a message ID");
    }
    return { provider: this.id, messageId: result.MessageId, status: "accepted" };
  }

  async sendPaymentReceipt(): Promise<MessageSendResult> {
    throw new MessagingDeliveryError("Payment receipts are available in-app and are not sent by SMS");
  }

  verifyWebhook(): boolean {
    return false;
  }
}
