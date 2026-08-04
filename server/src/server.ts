import "dotenv/config";
import { randomUUID } from "crypto";
import express, { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { Server } from "http";
import pinoHttp from "pino-http";
import { logger } from "./logger";
import { pool } from "./db";
import { env } from "./config/env";
import authRouter from "./routes/auth";
import partsRouter from "./routes/parts";
import ordersRouter from "./routes/orders";
import usersRouter from "./routes/users";
import homeRouter from "./routes/home";
import adminRouter from "./routes/admin";
import notificationsRouter from "./routes/notifications";
import paymentsRouter from "./routes/payments";
import locationsRouter from "./routes/locations";
import mediaRouter from "./routes/media";

export const app = express();

app.disable("x-powered-by");
if (env.isProduction) {
  app.set("trust proxy", env.TRUST_PROXY_HOPS);
}

app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers["x-request-id"];
      const requestId = typeof incoming === "string" && incoming.length <= 128 ? incoming : randomUUID();
      res.setHeader("x-request-id", requestId);
      return requestId;
    },
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    customLogLevel(
      _req: Request,
      res: Response,
      err?: Error
    ): "error" | "warn" | "info" {
      if (res.statusCode >= 500 || err) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
  })
);
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || env.corsOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed by CORS"));
    },
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id", "Idempotency-Key"],
    maxAge: 86400,
  })
);

app.use((req: Request, res: Response, next: NextFunction) => {
  if (
    env.isProduction &&
    env.ENFORCE_HTTPS &&
    !req.secure &&
    !["/healthz", "/readyz", "/health", "/api/health"].includes(req.path)
  ) {
    res.status(400).json({ ok: false, message: "HTTPS is required" });
    return;
  }
  next();
});

app.use(
  express.json({
    limit: env.JSON_BODY_LIMIT,
    verify: (req, _res, buf) => {
      const originalUrl = (req as Request).originalUrl || req.url || "";
      if (
        originalUrl.includes("/payments/webhook/monnify")
      ) {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      }
    },
  })
);

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: "quickserve-api" });
});

app.get('/readyz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');

    res.status(200).json({
      status: 'ready',
      database: 'connected',
    });
  } catch {
    res.status(503).json({
      status: 'not_ready',
      database: 'unavailable',
    });
  }
});

const readinessHandler = async (_req: Request, res: Response) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", service: "quickserve-api", db: "connected" });
  } catch (e) {
    logger.warn({ err: e }, "Readiness check failed");
    res.status(503).json({ status: "degraded", service: "quickserve-api", db: "disconnected" });
  }
};

app.get("/readyz", readinessHandler);
app.get("/health", readinessHandler);
app.get("/api/health", readinessHandler);

app.use(
  "/api",
  rateLimit({
    windowMs: 60_000,
    limit: env.isProduction ? 300 : 3_000,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { ok: false, message: "Too many requests. Please retry shortly." },
  })
);

app.use("/api/auth", authRouter);
app.use("/api/parts", partsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/users", usersRouter);
app.use("/api/home", homeRouter);
app.use("/api/admin", adminRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/locations", locationsRouter);
app.use("/api/media", mediaRouter);

app.use((req: Request, res: Response) => {
  req.log.warn(
    { method: req.method, path: req.originalUrl },
    "Route not found"
  );
  res.status(404).json({
    ok: false,
    message: "Route not found",
    method: req.method,
    path: req.originalUrl,
  });
});

const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const statusCode = typeof error?.status === "number" && error.status >= 400 ? error.status : 500;
  req.log[statusCode >= 500 ? "error" : "warn"]({ err: error }, "Request failed");
  res.status(statusCode).json({
    ok: false,
    message: statusCode >= 500 ? "Internal server error" : error.message || "Request failed",
    requestId: req.id,
  });
};

app.use(errorHandler);

let server: Server | undefined;

if (require.main === module) {
  server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "QuickServe API listening");
  });
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown started");

  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out");
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await pool.end();
    clearTimeout(forceExit);
    logger.info("Graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "Graceful shutdown failed");
    process.exit(1);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
