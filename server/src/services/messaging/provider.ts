export type MessageChannel = "whatsapp" | "sms";

export type MessageSendResult = {
  provider: string;
  messageId: string;
  status: string;
};

export interface MessagingProvider {
  readonly id: string;
  sendOtp(input: {
    phoneE164: string;
    code: string;
    channel: MessageChannel;
    purpose: "signup" | "phone_migration" | "phone_change" | "password_reset";
  }): Promise<MessageSendResult>;
  sendPaymentReceipt(input: {
    phoneE164: string;
    values: Record<string, string>;
  }): Promise<MessageSendResult>;
  verifyWebhook(input: { rawBody: Buffer; signature?: string }): boolean;
}
