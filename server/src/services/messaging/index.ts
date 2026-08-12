import { env } from "../../config/env";
import { MessagingProvider } from "./provider";
import { TermiiProvider } from "./termii";

let provider: MessagingProvider | undefined;

export function messagingProvider(): MessagingProvider {
  if (env.MESSAGING_PROVIDER !== "termii") {
    throw new Error("Phone messaging is not configured");
  }
  if (!provider) provider = new TermiiProvider();
  return provider;
}

export * from "./provider";
export * from "./termii";
