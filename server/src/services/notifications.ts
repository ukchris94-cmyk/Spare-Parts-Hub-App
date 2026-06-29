import { query } from "../db";

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

type PushTokenRow = { token: string };

async function sendPushNotifications(input: NotificationInput): Promise<void> {
  const tokenResult = input.recipientUserId
    ? await query<PushTokenRow>(
        `SELECT token FROM push_tokens WHERE user_id = $1`,
        [input.recipientUserId],
      )
    : await query<PushTokenRow>(
        `SELECT pt.token
         FROM push_tokens pt
         JOIN users u ON u.id = pt.user_id
         WHERE u.role = $1`,
        [input.recipientRole],
      );

  const tokens = tokenResult.rows
    .map((row) => row.token)
    .filter((token) => token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken["));

  if (!tokens.length || typeof fetch !== "function") return;

  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timeout = controller ? setTimeout(() => controller.abort(), 3500) : undefined;

  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      signal: controller?.signal,
      body: JSON.stringify(
        tokens.map((token) => ({
          to: token,
          sound: "default",
          title: input.title,
          body: input.message,
          data: {
            notificationId: input.id,
            type: input.type,
            relatedOrderId: input.relatedOrderId ?? undefined,
            relatedJobId: input.relatedJobId ?? undefined,
            relatedBargainOfferId: input.relatedBargainOfferId ?? undefined,
            ...(input.data ?? {}),
          },
        })),
      ),
    });
  } catch {
    return;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type NotificationInput = {
  id?: string;
  recipientUserId?: string | null;
  recipientRole: string;
  type: string;
  title: string;
  message: string;
  relatedOrderId?: string | null;
  relatedJobId?: string | null;
  relatedBargainOfferId?: string | null;
  data?: Record<string, unknown>;
};

export async function createNotification(input: NotificationInput): Promise<void> {
  const id = input.id ?? genId("ntf");
  await query(
    `INSERT INTO notifications
       (id, recipient_user_id, recipient_role, type, title, message, related_order_id, related_job_id, related_bargain_offer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
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

  await sendPushNotifications({ ...input, id }).catch(() => null);
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
