import { query } from "../db";
import { logger } from "../logger";

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

type PushTokenRow = { token: string; platform: string | null };

type ExpoTicket = {
  status?: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string; [key: string]: unknown };
};

type ExpoReceipt = {
  status?: "ok" | "error";
  message?: string;
  details?: { error?: string; [key: string]: unknown };
};

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function tokenShape(token: string): string {
  const prefix = token.split("[", 1)[0] || "unknown";
  return `${prefix}[...]`;
}

async function readExpoJson(response: Response): Promise<any> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

async function fetchExpoReceipts(ticketIds: string[]): Promise<void> {
  if (!ticketIds.length || typeof fetch !== "function") return;

  for (const ids of chunk(ticketIds, 100)) {
    const response = await fetch("https://exp.host/--/api/v2/push/getReceipts", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids }),
    });
    const payload = await readExpoJson(response);
    if (!response.ok) {
      logger.warn(
        { status: response.status, payload },
        "Expo push receipt request failed",
      );
      continue;
    }

    const receipts = payload?.data && typeof payload.data === "object" ? payload.data : {};
    const errors = Object.entries(receipts)
      .map(([id, receipt]) => ({ id, ...(receipt as ExpoReceipt) }))
      .filter((receipt) => receipt.status === "error");

    if (errors.length) {
      logger.warn({ errors }, "Expo push receipt errors");
    } else {
      logger.info({ receiptCount: Object.keys(receipts).length }, "Expo push receipts ok");
    }
  }
}

async function sendPushNotifications(input: NotificationInput): Promise<void> {
  const tokenResult = input.recipientUserId
    ? await query<PushTokenRow>(
        `SELECT token, platform FROM push_tokens WHERE user_id = $1`,
        [input.recipientUserId],
      )
    : await query<PushTokenRow>(
        `SELECT pt.token, pt.platform
         FROM push_tokens pt
         JOIN users u ON u.id = pt.user_id
         WHERE u.role = $1`,
        [input.recipientRole],
      );

  const validRows = tokenResult.rows.filter(
    (row) =>
      row.token.startsWith("ExponentPushToken[") ||
      row.token.startsWith("ExpoPushToken["),
  );
  const tokens = validRows.map((row) => row.token);

  logger.info(
    {
      recipientRole: input.recipientRole,
      recipientUserId: input.recipientUserId ?? null,
      tokenCount: tokens.length,
      platforms: Array.from(new Set(validRows.map((row) => row.platform || "unknown"))),
      tokenShapes: Array.from(new Set(tokens.map(tokenShape))),
      notificationType: input.type,
    },
    "Preparing Expo push send",
  );

  if (!tokens.length || typeof fetch !== "function") return;

  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timeout = controller ? setTimeout(() => controller.abort(), 3500) : undefined;

  try {
    const ticketIds: string[] = [];
    for (const tokenBatch of chunk(tokens, 100)) {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        signal: controller?.signal,
        body: JSON.stringify(
          tokenBatch.map((token) => ({
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
      const payload = await readExpoJson(response);
      if (!response.ok) {
        logger.warn(
          { status: response.status, payload },
          "Expo push send request failed",
        );
        continue;
      }

      const tickets: ExpoTicket[] = Array.isArray(payload?.data) ? payload.data : [];
      const errors = tickets.filter((ticket) => ticket.status === "error");
      if (errors.length) {
        logger.warn({ errors }, "Expo push ticket errors");
      } else {
        logger.info({ ticketCount: tickets.length }, "Expo push tickets ok");
      }

      ticketIds.push(
        ...tickets
          .map((ticket) => (ticket.status === "ok" && ticket.id ? ticket.id : ""))
          .filter(Boolean),
      );
    }

    await fetchExpoReceipts(ticketIds).catch((err) => {
      logger.warn({ err }, "Expo push receipt lookup failed");
    });
  } catch (err) {
    logger.warn({ err }, "Expo push send failed");
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
