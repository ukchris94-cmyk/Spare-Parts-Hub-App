import { Router, Request, Response } from "express";
import { query } from "../db";

const router = Router();

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

router.post("/", async (req: Request, res: Response) => {
  const log = req.log;
  const { userId, items } = req.body as { userId?: string; items?: unknown[] };

  if (!userId) {
    return res.status(400).json({ ok: false, message: "userId is required" });
  }

  const id = genId("ord");
  const itemsJson = items && Array.isArray(items) ? JSON.stringify(items) : "[]";

  try {
    await query(
      "INSERT INTO orders (id, user_id, status, items) VALUES ($1, $2, $3, $4::jsonb)",
      [id, userId, "pending", itemsJson]
    );
    log.info({ orderId: id, userId }, "Order created");
    return res.status(201).json({
      id,
      userId,
      items: items ?? [],
      status: "pending",
    });
  } catch (err) {
    log.error({ err, userId }, "Order create failed");
    throw err;
  }
});

router.get("/:orderId", async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const { rows } = await query<{ id: string; user_id: string; status: string; items: unknown }>(
    "SELECT id, user_id, status, items FROM orders WHERE id = $1",
    [orderId]
  );
  const order = rows[0];
  if (!order) {
    return res.status(404).json({ ok: false, message: "Order not found" });
  }
  return res.json({
    id: order.id,
    userId: order.user_id,
    status: order.status,
    items: order.items ?? [],
    etaMinutes: order.status === "in_transit" ? 25 : undefined,
  });
});

export default router;
