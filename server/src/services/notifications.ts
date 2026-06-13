import { query } from "../db";

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

type NotificationInput = {
  recipientUserId?: string | null;
  recipientRole: string;
  type: string;
  title: string;
  message: string;
  relatedOrderId?: string | null;
  relatedJobId?: string | null;
  relatedBargainOfferId?: string | null;
};

export async function createNotification(input: NotificationInput): Promise<void> {
  await query(
    `INSERT INTO notifications
       (id, recipient_user_id, recipient_role, type, title, message, related_order_id, related_job_id, related_bargain_offer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      genId("ntf"),
      input.recipientUserId ?? null,
      input.recipientRole,
      input.type,
      input.title,
      input.message,
      input.relatedOrderId ?? null,
      input.relatedJobId ?? null,
      input.relatedBargainOfferId ?? null,
    ],
  );
}

export async function notifyRole(
  role: string,
  input: Omit<NotificationInput, "recipientRole" | "recipientUserId">,
): Promise<void> {
  const { rows } = await query<{ id: string }>("SELECT id FROM users WHERE role = $1", [role]);
  await Promise.all(
    rows.map((row) =>
      createNotification({ ...input, recipientRole: role, recipientUserId: row.id }),
    ),
  );
}
