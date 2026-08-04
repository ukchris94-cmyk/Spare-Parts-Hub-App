import pino from "pino";
import { env } from "./config/env";

const isDev = !env.isProduction && !env.isTest;

export const logger = pino({
  name: "quickserve-api",
  level: env.LOG_LEVEL || (isDev ? "debug" : "info"),
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.password",
      "req.body.currentPassword",
      "req.body.newPassword",
      "req.body.refreshToken",
      "req.body.token",
      "res.headers['set-cookie']",
      "authorization",
      "password",
      "refreshToken",
      "secret",
      "apiKey",
    ],
    censor: "[REDACTED]",
  },
  ...(isDev
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
});

export type AppLogger = pino.Logger;
