import { Router, Request, Response } from "express";
import { query } from "../db";
import { requireAuthenticated } from "../middleware/auth";

const router = Router();

router.use(requireAuthenticated);

router.get("/", async (req: Request, res: Response) => {
  const user = req.user;
  if (!user) return res.status(401).json({ ok: false, message: "Authentication required" });

  const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 50;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 50;

  const { rows } = await query<{
    id: string;
    recipient_user_id: string | null;
    recipient_role: string;
    type: string;
    title: string;
    message: string;
    related_order_id: string | null;
    related_job_id: string | null;
    related_bargain_offer_id: string | null;
    read: boolean;
    created_at: string;
  }>(
    `SELECT id, recipient_user_id, recipient_role, type, title, message,
            related_order_id, related_job_id, related_bargain_offer_id, read, created_at
     FROM notifications
     WHERE recipient_user_id = $1 OR (recipient_user_id IS NULL AND recipient_role = $2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [user.id, user.role, limit],
  );

  return res.json({
    ok: true,
    notifications: rows.map((row) => ({
      id: row.id,
      recipientUserId: row.recipient_user_id,
      recipientRole: row.recipient_role,
      type: row.type,
      title: row.title,
      message: row.message,
      relatedOrderId: row.related_order_id,
      relatedJobId: row.related_job_id,
      relatedBargainOfferId: row.related_bargain_offer_id,
      read: row.read,
      createdAt: row.created_at,
    })),
  });
});

router.post("/push-token", async (req: Request, res: Response) => {
  const user = req.user;
  if (!user) return res.status(401).json({ ok: false, message: "Authentication required" });

  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  const platform = typeof req.body?.platform === "string" ? req.body.platform.trim().slice(0, 40) : null;

  if (!token) {
    return res.status(400).json({ ok: false, message: "Push token is required" });
  }

  await query(
    `INSERT INTO push_tokens (id, user_id, token, platform)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       platform = EXCLUDED.platform,
       updated_at = NOW()`,
    [`pt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, user.id, token, platform],
  );

  return res.status(201).json({ ok: true });
});

router.get("/unread-count", async (req: Request, res: Response) => {
  const user = req.user;
  if (!user) return res.status(401).json({ ok: false, message: "Authentication required" });

  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM notifications
     WHERE read = FALSE
       AND (recipient_user_id = $1 OR (recipient_user_id IS NULL AND recipient_role = $2))`,
    [user.id, user.role],
  );

  return res.json({ ok: true, count: Number.parseInt(rows[0]?.count ?? "0", 10) || 0 });
});

router.patch("/:notificationId/read", async (req: Request, res: Response) => {
  const user = req.user;
  const { notificationId } = req.params;
  if (!user) return res.status(401).json({ ok: false, message: "Authentication required" });

  const result = await query(
    `UPDATE notifications
     SET read = TRUE
     WHERE id = $1
       AND (recipient_user_id = $2 OR (recipient_user_id IS NULL AND recipient_role = $3))`,
    [notificationId, user.id, user.role],
  );

  if (!result.rowCount) return res.status(404).json({ ok: false, message: "Notification not found" });
  return res.json({ ok: true });
});

router.patch("/read-all", async (req: Request, res: Response) => {
  const user = req.user;
  if (!user) return res.status(401).json({ ok: false, message: "Authentication required" });

  await query(
    `UPDATE notifications
     SET read = TRUE
     WHERE recipient_user_id = $1 OR (recipient_user_id IS NULL AND recipient_role = $2)`,
    [user.id, user.role],
  );

  return res.json({ ok: true });
});

export default router;
