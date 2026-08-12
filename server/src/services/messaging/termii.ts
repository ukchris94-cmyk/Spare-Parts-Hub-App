import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../../config/env";
import { termiiDestination } from "../phoneNumbers";
import { MessageChannel, MessageSendResult, MessagingProvider } from "./provider";

type TermiiResponse = {
  code?: string;
  status?: string | number;
  message?: string;
  message_id?: string;
  message_id_str?: string;
  pinId?: string;
  pin_id?: string;
};

export class MessagingConfigurationError extends Error {}
export class MessagingDeliveryError extends Error {}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new MessagingConfigurationError(`${name} is not configured`);
  return normalized;
}

function constantTimeHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left.toLowerCase(), "utf8");
  const rightBuffer = Buffer.from(right.toLowerCase(), "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class TermiiProvider implements MessagingProvider {
  readonly id = "termii";

  private async request(path: string, body: Record<string, unknown>): Promise<TermiiResponse> {
    const baseUrl = required(env.TERMII_BASE_URL, "TERMII_BASE_URL").replace(/\/+$/, "");
    const apiKey = required(env.TERMII_API_KEY, "TERMII_API_KEY");
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, api_key: apiKey }),
      signal: AbortSignal.timeout(12_000),
    });
    const payload = (await response.json().catch(() => ({}))) as TermiiResponse;
    const messageId = payload.message_id_str || payload.message_id || payload.pin_id || payload.pinId;
    const accepted = response.ok && (payload.code === "ok" || String(payload.status) === "200" || !!messageId);
    if (!accepted || !messageId) {
      throw new MessagingDeliveryError(payload.message || `Termii rejected message (${response.status})`);
    }
    return payload;
  }

  async sendOtp(input: {
    phoneE164: string;
    code: string;
    channel: MessageChannel;
    purpose: "signup" | "phone_migration" | "phone_change" | "password_reset";
  }): Promise<MessageSendResult> {
    const destination = termiiDestination(input.phoneE164);
    let payload: TermiiResponse;
    if (input.channel === "whatsapp") {
      const templateId = required(env.TERMII_AUTH_TEMPLATE_ID, "TERMII_AUTH_TEMPLATE_ID");
      const deviceId = required(env.TERMII_WHATSAPP_DEVICE_ID, "TERMII_WHATSAPP_DEVICE_ID");
      payload = await this.request("/api/send/template", {
        phone_number: destination,
        device_id: deviceId,
        template_id: templateId,
        data: { otp: input.code },
      });
    } else {
      payload = await this.request("/api/sms/send", {
        to: destination,
        from: required(env.TERMII_SENDER_ID, "TERMII_SENDER_ID"),
        sms: `Your QuickServe security code is ${input.code}. It expires in 5 minutes. Do not share it.`,
        type: "plain",
        channel: "dnd",
      });
    }
    return {
      provider: this.id,
      messageId: String(payload.message_id_str || payload.message_id || payload.pin_id || payload.pinId),
      status: payload.message || String(payload.status || "accepted"),
    };
  }

  async sendPaymentReceipt(input: {
    phoneE164: string;
    values: Record<string, string>;
  }): Promise<MessageSendResult> {
    const payload = await this.request("/api/send/template", {
      phone_number: termiiDestination(input.phoneE164),
      device_id: required(env.TERMII_WHATSAPP_DEVICE_ID, "TERMII_WHATSAPP_DEVICE_ID"),
      template_id: required(env.TERMII_PAYMENT_RECEIPT_TEMPLATE_ID, "TERMII_PAYMENT_RECEIPT_TEMPLATE_ID"),
      data: input.values,
    });
    return {
      provider: this.id,
      messageId: String(payload.message_id_str || payload.message_id),
      status: payload.message || String(payload.status || "accepted"),
    };
  }

  verifyWebhook(input: { rawBody: Buffer; signature?: string }): boolean {
    const secret = env.TERMII_SECRET_KEY?.trim();
    const signature = input.signature?.trim();
    if (!secret || !signature || !/^[a-f0-9]{128}$/i.test(signature)) return false;
    const expected = createHmac("sha512", secret).update(input.rawBody).digest("hex");
    return constantTimeHex(expected, signature);
  }
}
