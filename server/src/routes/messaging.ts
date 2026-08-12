import { Request, Response, Router } from "express";
import { z } from "zod";
import { query } from "../db";
import { messagingProvider } from "../services/messaging";

const router = Router();

const deliverySchema = z.object({
  message_id: z.union([z.string(), z.number()]).optional(),
  id: z.union([z.string(), z.number()]).optional(),
  status: z.string().trim().max(100),
  channel: z.string().trim().max(50).optional(),
}).passthrough();

router.post("/webhook/termii", async (req: Request, res: Response) => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const signature = req.header("x-termii-signature") || undefined;
  if (!rawBody || !messagingProvider().verifyWebhook({ rawBody, signature })) {
    req.log.warn("Rejected Termii webhook with invalid signature");
    res.status(401).json({ ok: false, message: "Invalid webhook signature" });
    return;
  }

  const parsed = deliverySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Invalid delivery event" });
    return;
  }
  const messageId = String(parsed.data.message_id || parsed.data.id || "").trim();
  if (!messageId) {
    res.status(400).json({ ok: false, message: "Missing provider message ID" });
    return;
  }
  const status = parsed.data.status.slice(0, 100);
  await Promise.all([
    query(
      `UPDATE auth_message_attempts SET status = $2, updated_at = NOW()
       WHERE provider = 'termii' AND provider_message_id = $1`,
      [messageId, status]
    ),
    query(
      `UPDATE payment_receipt_deliveries
       SET status = $2,
           delivered_at = CASE WHEN LOWER($2) = 'delivered' THEN NOW() ELSE delivered_at END,
           updated_at = NOW()
       WHERE provider = 'termii' AND provider_message_id = $1`,
      [messageId, status]
    ),
  ]);
  res.status(204).send();
});

export default router;
