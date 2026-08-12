import { env } from "../../config/env";
import { MessagingProvider } from "./provider";
import { AwsSmsProvider } from "./awsSms";

let provider: MessagingProvider | undefined;

export function messagingProvider(): MessagingProvider {
  if (env.MESSAGING_PROVIDER !== "aws_sms") {
    throw new Error("Phone messaging is not configured");
  }
  if (!provider) provider = new AwsSmsProvider();
  return provider;
}

export * from "./provider";
export * from "./awsSms";
