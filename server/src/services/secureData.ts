import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { env } from "../config/env";

let client: KMSClient | undefined;

function kms(): KMSClient {
  if (!client) client = new KMSClient({ region: env.AWS_REGION });
  return client;
}

function keyId(): string {
  const value = process.env.PAYOUT_KMS_KEY_ID?.trim();
  if (!value || !env.AWS_REGION) {
    throw new Error("PAYOUT_KMS_KEY_ID and AWS_REGION are required for payout account encryption");
  }
  return value;
}

function context(vendorId: string) {
  return { application: "quickserve", purpose: "vendor-payout", vendorId };
}

export async function encryptPayoutAccountNumber(vendorId: string, accountNumber: string): Promise<string> {
  const result = await kms().send(
    new EncryptCommand({
      KeyId: keyId(),
      Plaintext: Buffer.from(accountNumber, "utf8"),
      EncryptionContext: context(vendorId),
    })
  );
  if (!result.CiphertextBlob) throw new Error("KMS did not return encrypted data");
  return Buffer.from(result.CiphertextBlob).toString("base64");
}

export async function decryptPayoutAccountNumber(vendorId: string, ciphertext: string): Promise<string> {
  const result = await kms().send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(ciphertext, "base64"),
      EncryptionContext: context(vendorId),
    })
  );
  if (!result.Plaintext) throw new Error("KMS did not return decrypted data");
  return Buffer.from(result.Plaintext).toString("utf8");
}

