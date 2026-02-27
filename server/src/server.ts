import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRouter from "./routes/auth";
import partsRouter from "./routes/parts";
import ordersRouter from "./routes/orders";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "spareparts-hub" });
});

app.use("/api/auth", authRouter);
app.use("/api/parts", partsRouter);
app.use("/api/orders", ordersRouter);

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`SpareParts Hub API running on http://localhost:${PORT}`);
});

