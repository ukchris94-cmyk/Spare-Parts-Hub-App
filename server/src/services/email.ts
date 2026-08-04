import nodemailer, { Transporter } from "nodemailer";
import { env } from "../config/env";
import { logger } from "../logger";

let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      tls: { minVersion: "TLSv1.2" },
    });
  }
  return transporter;
}

export async function sendTransactionalEmail(params: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  template: string;
}): Promise<void> {
  if (env.emailDeliveryMode === "disabled") {
    throw new Error("Transactional email delivery is disabled");
  }

  if (env.emailDeliveryMode === "log") {
    logger.info(
      { recipientDomain: params.to.split("@")[1], template: params.template },
      "Transactional email suppressed in local mode"
    );
    return;
  }

  const from = env.SMTP_FROM || env.EMAIL_FROM || env.SMTP_USER;
  if (!env.SMTP_USER || !env.SMTP_PASS || !from) {
    throw new Error("SMTP_USER, SMTP_PASS, and SMTP_FROM are required for email delivery");
  }

  const result = await getTransporter().sendMail({
    from,
    to: params.to,
    subject: params.subject,
    text: params.text,
    ...(params.html ? { html: params.html } : {}),
    ...(env.EMAIL_REPLY_TO ? { replyTo: env.EMAIL_REPLY_TO } : {}),
  });
  logger.info(
    {
      messageId: result.messageId,
      recipientDomain: params.to.split("@")[1],
      template: params.template,
    },
    "Transactional email accepted by SMTP server"
  );
}
