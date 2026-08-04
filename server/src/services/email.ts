import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { env } from "../config/env";
import { logger } from "../logger";

let client: SESv2Client | undefined;

function getClient(): SESv2Client {
  if (!client) {
    client = new SESv2Client({ region: env.AWS_REGION });
  }
  return client;
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

  if (!env.EMAIL_FROM || !env.AWS_REGION) {
    throw new Error("EMAIL_FROM and AWS_REGION are required for SES email delivery");
  }

  await getClient().send(
    new SendEmailCommand({
      FromEmailAddress: env.EMAIL_FROM,
      ...(env.EMAIL_REPLY_TO ? { ReplyToAddresses: [env.EMAIL_REPLY_TO] } : {}),
      Destination: { ToAddresses: [params.to] },
      Content: {
        Simple: {
          Subject: { Data: params.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: params.text, Charset: "UTF-8" },
            ...(params.html ? { Html: { Data: params.html, Charset: "UTF-8" } } : {}),
          },
        },
      },
    })
  );
}

