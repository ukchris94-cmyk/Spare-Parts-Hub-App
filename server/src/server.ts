import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import pinoHttp from "pino-http";
import { logger } from "./logger";
import { pool } from "./db";
import authRouter from "./routes/auth";
import partsRouter from "./routes/parts";
import ordersRouter from "./routes/orders";

dotenv.config();

const app = express();

app.use(
  pinoHttp({
    logger,
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
app.use(cors());
app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", service: "spareparts-hub", db: "connected" });
  } catch (e) {
    logger.warn({ err: e }, "Health check: DB not connected");
    res.status(503).json({ status: "degraded", service: "spareparts-hub", db: "disconnected" });
  }
});

app.use("/api/auth", authRouter);
app.use("/api/parts", partsRouter);
app.use("/api/orders", ordersRouter);

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  logger.info({ port: PORT }, "SpareParts Hub API listening");
});
