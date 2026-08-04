import "dotenv/config";
import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
    DATABASE_URL: z.string().trim().optional(),
    DATABASE_SSL: booleanString.optional(),
    DATABASE_CA_BASE64: z.string().trim().optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
    DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
    JSON_BODY_LIMIT: z.string().trim().default("1mb"),
    CORS_ORIGINS: z.string().trim().optional(),
    ENFORCE_HTTPS: booleanString.optional(),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
    AUTH_TOKEN_SECRET: z.string().min(32).optional(),
    REFRESH_TOKEN_PEPPER: z.string().min(32).optional(),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    ALLOW_LEGACY_AUTH_TOKENS: booleanString.optional(),
    APP_DEEP_LINK_SCHEME: z.string().regex(/^[a-z][a-z0-9+.-]*$/i).default("sparepartshubmobileclean"),
    AWS_REGION: z.string().trim().optional(),
    EMAIL_FROM: z.string().trim().optional(),
    EMAIL_REPLY_TO: z.string().trim().optional(),
    EMAIL_DELIVERY_MODE: z.enum(["ses", "log", "disabled"]).optional(),
    EXPO_ACCESS_TOKEN: z.string().trim().optional(),
    PUBLIC_API_URL: z.string().url().optional(),
    PAYMENTS_ENABLED: booleanString.default(false),
    PAYMENT_PROVIDER: z.enum(["monnify"]).default("monnify"),
    MONNIFY_BASE_URL: z.string().url().optional(),
    MONNIFY_API_KEY: z.string().trim().optional(),
    MONNIFY_SECRET_KEY: z.string().trim().optional(),
    MONNIFY_CONTRACT_CODE: z.string().trim().optional(),
    MONNIFY_REDIRECT_URL: z.string().url().optional(),
    MONNIFY_WEBHOOK_IPS: z.string().trim().optional(),
    MONNIFY_DISBURSEMENTS_ENABLED: booleanString.optional(),
    MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT: z.string().trim().optional(),
    MEDIA_BUCKET: z.string().trim().optional(),
    MEDIA_KMS_KEY_ID: z.string().trim().optional(),
    MEDIA_CDN_URL: z.string().url().optional(),
    PAYOUT_KMS_KEY_ID: z.string().trim().optional(),
    GOOGLE_MAPS_SERVER_API_KEY: z.string().trim().optional(),
    JOBS_QUEUE_URL: z.string().url().optional(),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && !value.DATABASE_URL) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required in production",
      });
    }
    if (value.NODE_ENV === "production" && !value.AUTH_TOKEN_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_TOKEN_SECRET"],
        message: "AUTH_TOKEN_SECRET (at least 32 characters) is required in production",
      });
    }
    if (value.NODE_ENV === "production" && !value.REFRESH_TOKEN_PEPPER) {
      context.addIssue({
        code: "custom",
        path: ["REFRESH_TOKEN_PEPPER"],
        message: "REFRESH_TOKEN_PEPPER (at least 32 characters) is required in production",
      });
    }
    if (value.NODE_ENV === "production") {
      const required: Array<[string, unknown]> = [
        ["PUBLIC_API_URL", value.PUBLIC_API_URL],
        ["AWS_REGION", value.AWS_REGION],
        ["EMAIL_FROM", value.EMAIL_FROM],
        ["GOOGLE_MAPS_SERVER_API_KEY", value.GOOGLE_MAPS_SERVER_API_KEY],
      ];
      for (const [name, configured] of required) {
        if (!configured) {
          context.addIssue({
            code: "custom",
            path: [name],
            message: `${name} is required in production`,
          });
        }
      }
      if (value.PAYMENTS_ENABLED) {
        const paymentRequired: Array<[string, unknown]> = [
          ["MONNIFY_BASE_URL", value.MONNIFY_BASE_URL],
          ["MONNIFY_API_KEY", value.MONNIFY_API_KEY],
          ["MONNIFY_SECRET_KEY", value.MONNIFY_SECRET_KEY],
          ["MONNIFY_CONTRACT_CODE", value.MONNIFY_CONTRACT_CODE],
          ["MONNIFY_REDIRECT_URL", value.MONNIFY_REDIRECT_URL],
          ["MONNIFY_WEBHOOK_IPS", value.MONNIFY_WEBHOOK_IPS],
          ["PAYOUT_KMS_KEY_ID", value.PAYOUT_KMS_KEY_ID],
        ];
        for (const [name, configured] of paymentRequired) {
          if (!configured) {
            context.addIssue({
              code: "custom",
              path: [name],
              message: `${name} is required when PAYMENTS_ENABLED=true`,
            });
          }
        }
      }
      if (value.PUBLIC_API_URL && !value.PUBLIC_API_URL.startsWith("https://")) {
        context.addIssue({ code: "custom", path: ["PUBLIC_API_URL"], message: "PUBLIC_API_URL must use HTTPS" });
      }
      if (value.MONNIFY_REDIRECT_URL && !value.MONNIFY_REDIRECT_URL.startsWith("https://")) {
        context.addIssue({ code: "custom", path: ["MONNIFY_REDIRECT_URL"], message: "MONNIFY_REDIRECT_URL must use HTTPS" });
      }
      if (value.MONNIFY_DISBURSEMENTS_ENABLED && !value.MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT) {
        context.addIssue({
          code: "custom",
          path: ["MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT"],
          message: "A source account is required when Monnify disbursements are enabled",
        });
      }
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid server configuration: ${details}`);
}

const values = parsed.data;

export const env = {
  ...values,
  ENFORCE_HTTPS: values.ENFORCE_HTTPS ?? values.NODE_ENV === "production",
  isProduction: values.NODE_ENV === "production",
  isTest: values.NODE_ENV === "test",
  databaseUrl:
    values.DATABASE_URL || "postgresql://localhost:5432/spareparts_hub?user=postgres",
  databaseSsl: values.DATABASE_SSL ?? values.NODE_ENV === "production",
  allowLegacyAuthTokens:
    values.ALLOW_LEGACY_AUTH_TOKENS ?? values.NODE_ENV !== "production",
  emailDeliveryMode:
    values.EMAIL_DELIVERY_MODE ?? (values.NODE_ENV === "production" ? "ses" : "log"),
  corsOrigins: new Set(
    (values.CORS_ORIGINS || (values.NODE_ENV === "production" ? "" : "http://localhost:8081,http://localhost:8085"))
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  ),
} as const;
