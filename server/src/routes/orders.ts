import { Router, Request, Response } from "express";
import { query } from "../db";
import { createNotification, notifyRole } from "../services/notifications";

const router = Router();

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "ready_for_pickup",
  "in_transit",
  "delivered",
  "cancelled",
  "rejected",
] as const;

type OrderStatus = (typeof ORDER_STATUSES)[number];

function isValidStatus(value: string): value is OrderStatus {
  return ORDER_STATUSES.includes(value as OrderStatus);
}

async function safeNotify(log: Request["log"], task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (err) {
    log.warn({ err }, "Notification write failed");
  }
}

function buildTrackingSteps(status: string) {
  const activeIndex =
    status === "delivered"
      ? 3
      : status === "in_transit"
      ? 2
      : status === "ready_for_pickup"
      ? 1
      : 0;

  const steps = [
    { key: "confirmed", title: "Order confirmed" },
    { key: "ready_for_pickup", title: "Vendor ready for pickup" },
    { key: "in_transit", title: "Dispatcher on route" },
    { key: "delivered", title: "Delivered" },
  ];

  return steps.map((step, index) => ({
    ...step,
    state:
      index < activeIndex ? "completed" : index === activeIndex ? "active" : "pending",
  }));
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
      [id, userId, "pending", itemsJson],
    );
    const firstQuoteId =
      Array.isArray(items) &&
      typeof items[0] === "object" &&
      items[0] &&
      "sourceQuoteId" in items[0] &&
      typeof (items[0] as { sourceQuoteId?: unknown }).sourceQuoteId === "string"
        ? ((items[0] as { sourceQuoteId: string }).sourceQuoteId || "").trim()
        : "";
    const firstRequestId =
      Array.isArray(items) &&
      typeof items[0] === "object" &&
      items[0] &&
      "sourceRequestId" in items[0] &&
      typeof (items[0] as { sourceRequestId?: unknown }).sourceRequestId === "string"
        ? ((items[0] as { sourceRequestId: string }).sourceRequestId || "").trim()
        : "";
    if (firstQuoteId && firstRequestId) {
      await query(
        `UPDATE part_request_quotes
         SET status = 'accepted', updated_at = NOW()
         WHERE id = $1 AND request_id = $2`,
        [firstQuoteId, firstRequestId],
      );
      await query(
        `UPDATE part_request_quotes
         SET status = CASE WHEN id = $1 THEN status ELSE 'closed' END,
             updated_at = NOW()
         WHERE request_id = $2`,
        [firstQuoteId, firstRequestId],
      );
      await query(
        `UPDATE part_requests
         SET status = 'matched'
         WHERE id = $1`,
        [firstRequestId],
      );
    }
    const partIds = Array.isArray(items)
      ? Array.from(
          new Set(
            items
              .map((item: any) =>
                typeof item?.partId === "string" && item.partId.trim()
                  ? item.partId.trim()
                  : null,
              )
              .filter((partId: string | null): partId is string => partId !== null),
          ),
        )
      : [];

    await safeNotify(log, async () => {
      if (partIds.length > 0) {
        const { rows: vendorRows } = await query<{ user_id: string | null }>(
          "SELECT DISTINCT user_id FROM parts WHERE id = ANY($1::text[]) AND user_id IS NOT NULL",
          [partIds],
        );
        await Promise.all(
          vendorRows
            .filter((row): row is { user_id: string } => typeof row.user_id === "string")
            .map((row) =>
              createNotification({
                recipientUserId: row.user_id,
                recipientRole: "vendor",
                type: "new_order",
                title: "New order needs review",
                message: "A customer placed an order containing one of your parts. Accept or reject it from Orders.",
                relatedOrderId: id,
              }),
            ),
        );
      }

      await Promise.all([
        notifyRole("admin", {
          type: "system_order_activity",
          title: "New order created",
          message: "A new customer order was created.",
          relatedOrderId: id,
        }),
        createNotification({
          recipientUserId: userId,
          recipientRole: "user",
          type: "order_created",
          title: "Order placed",
          message: "Your order was submitted and is waiting for vendor confirmation.",
          relatedOrderId: id,
        }),
      ]);
    });

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

router.get("/user/:userId", async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { rows } = await query<{
    id: string;
    user_id: string;
    status: string;
    created_at: string;
    items: unknown;
  }>(
    `SELECT id, user_id, status, created_at, items
     FROM orders
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );

  const orders = rows.map((order) => ({
    id: order.id,
    userId: order.user_id,
    status: order.status,
    createdAt: order.created_at,
    items: Array.isArray(order.items) ? order.items : [],
  }));

  const partIds = Array.from(
    new Set(
      orders.flatMap((order) =>
        order.items
          .map((item: any) =>
            typeof item?.partId === "string" && item.partId.trim()
              ? item.partId.trim()
              : null,
          )
          .filter((id: string | null): id is string => id !== null),
      ),
    ),
  );

  let vendorByPartId = new Map<string, string>();
  if (partIds.length > 0) {
    try {
      const { rows: vendorRows } = await query<{
        part_id: string;
        vendor_name: string | null;
      }>(
        `SELECT
           p.id AS part_id,
           COALESCE(NULLIF(u.first_name, ''), split_part(u.email, '@', 1), 'Vendor') AS vendor_name
         FROM parts p
         LEFT JOIN users u ON u.id = p.user_id
         WHERE p.id = ANY($1::text[])`,
        [partIds],
      );
      vendorByPartId = new Map(
        vendorRows.map((row) => [row.part_id, row.vendor_name ?? "Vendor"]),
      );
    } catch (err) {
      req.log.warn({ err }, "Skipping vendor enrichment for orders");
    }
  }

  return res.json({
    ok: true,
    orders: orders.map((order) => ({
      ...order,
      items: order.items.map((item: any) => {
        const partId =
          typeof item?.partId === "string" && item.partId.trim()
            ? item.partId.trim()
            : "";
        const existingVendorName =
          typeof item?.vendorName === "string" && item.vendorName.trim()
            ? item.vendorName.trim()
            : typeof item?.vendor_name === "string" && item.vendor_name.trim()
              ? item.vendor_name.trim()
              : "";
        const normalizedExistingVendorName = existingVendorName.toLowerCase();
        const hasPlaceholderVendorName =
          normalizedExistingVendorName === "vendor" ||
          normalizedExistingVendorName === "unknown vendor" ||
          normalizedExistingVendorName === "n/a";
        const resolvedVendorName =
          (!hasPlaceholderVendorName ? existingVendorName : "") ||
          (partId ? vendorByPartId.get(partId) : undefined) ||
          "Vendor";
        return {
          ...item,
          vendorName: resolvedVendorName,
        };
      }),
    })),
  });
});

router.get("/vendor/:userId", async (req: Request, res: Response) => {
  const { userId } = req.params;

  const vendorPartsResult = await query<{ id: string }>(
    `SELECT id
     FROM parts
     WHERE user_id = $1`,
    [userId],
  );
  const vendorPartIds = new Set(vendorPartsResult.rows.map((row) => row.id));

  if (vendorPartIds.size === 0) {
    return res.json({ ok: true, orders: [] });
  }

  const { rows } = await query<{
    id: string;
    user_id: string;
    status: string;
    created_at: string;
    items: unknown;
    buyer_name: string | null;
  }>(
    `SELECT
       o.id,
       o.user_id,
       o.status,
       o.created_at,
       o.items,
       COALESCE(NULLIF(u.first_name, ''), split_part(u.email, '@', 1)) AS buyer_name
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     ORDER BY o.created_at DESC`,
  );

  const orders = rows
    .map((order) => {
      const items = Array.isArray(order.items) ? order.items : [];
      const matchedItems = items.filter((item: any) => {
        const partId =
          typeof item?.partId === "string" && item.partId.trim()
            ? item.partId.trim()
            : "";
        return vendorPartIds.has(partId);
      });

      if (matchedItems.length === 0) {
        return null;
      }

      return {
        id: order.id,
        userId: order.user_id,
        buyerName: order.buyer_name,
        status: order.status,
        createdAt: order.created_at,
        items: matchedItems,
      };
    })
    .filter(
      (
        order,
      ): order is {
        id: string;
        userId: string;
        buyerName: string | null;
        status: string;
        createdAt: string;
        items: unknown[];
      } => order !== null,
    );

  return res.json({ ok: true, orders });
});

router.get("/pending", async (req: Request, res: Response) => {
  const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 20;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
  const statuses = ["confirmed", "ready_for_pickup"];
  const { rows } = await query<{
    id: string;
    user_id: string;
    status: string;
    created_at: string;
    items: unknown;
    buyer_name: string | null;
  }>(
    `SELECT
       o.id,
       o.user_id,
       o.status,
       o.created_at,
       o.items,
       COALESCE(NULLIF(u.first_name, ''), split_part(u.email, '@', 1)) AS buyer_name
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     WHERE status = ANY($1::text[])
     ORDER BY o.created_at DESC
     LIMIT $2`,
    [statuses, limit],
  );

  return res.json({
    ok: true,
    orders: rows.map((order) => ({
      id: order.id,
      userId: order.user_id,
      buyerName: order.buyer_name,
      status: order.status,
      createdAt: order.created_at,
      items: order.items ?? [],
    })),
  });
});

async function orderContainsVendorPart(orderId: string, vendorUserId: string): Promise<boolean> {
  const orderResult = await query<{ items: unknown }>(
    `SELECT items FROM orders WHERE id = $1 LIMIT 1`,
    [orderId],
  );
  const order = orderResult.rows[0];
  const partIds = Array.isArray(order?.items)
    ? Array.from(
        new Set(
          order.items
            .map((item: any) => (typeof item?.partId === "string" ? item.partId.trim() : ""))
            .filter(Boolean),
        ),
      )
    : [];

  if (!partIds.length) return false;

  const partResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM parts
     WHERE user_id = $1 AND id = ANY($2::text[])`,
    [vendorUserId, partIds],
  );
  return Number.parseInt(partResult.rows[0]?.count ?? "0", 10) > 0;
}

router.post("/:orderId/vendor-decision", async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const log = req.log;
  const vendorUserId = typeof req.body?.vendorUserId === "string" ? req.body.vendorUserId.trim() : "";
  const action = typeof req.body?.action === "string" ? req.body.action.trim().toLowerCase() : "";

  if (!vendorUserId) {
    return res.status(400).json({ ok: false, message: "vendorUserId is required" });
  }
  if (!["accept", "reject"].includes(action)) {
    return res.status(400).json({ ok: false, message: "Action must be accept or reject" });
  }

  const isVendorOrder = await orderContainsVendorPart(orderId, vendorUserId);
  if (!isVendorOrder) {
    return res.status(403).json({ ok: false, message: "This order is not linked to your vendor inventory" });
  }

  const nextStatus = action === "accept" ? "confirmed" : "cancelled";
  const { rows } = await query<{ id: string; user_id: string; status: string; updated_at: string }>(
    `UPDATE orders
     SET status = $1, updated_at = NOW()
     WHERE id = $2 AND status = 'pending'
     RETURNING id, user_id, status, updated_at`,
    [nextStatus, orderId],
  );
  const order = rows[0];

  if (!order) {
    return res.status(409).json({
      ok: false,
      message: "Order is no longer waiting for vendor review",
    });
  }

  await safeNotify(log, async () => {
    if (action === "accept") {
      await Promise.all([
        createNotification({
          recipientUserId: order.user_id,
          recipientRole: "user",
          type: "order_vendor_accepted",
          title: "Order accepted",
          message: "The vendor accepted your order. Delivery coordination can now begin.",
          relatedOrderId: order.id,
        }),
        notifyRole("dispatcher", {
          type: "order_coordination",
          title: "Order ready for coordination",
          message: "A vendor accepted an order that may need pickup or delivery coordination.",
          relatedOrderId: order.id,
        }),
      ]);
      return;
    }

    await createNotification({
      recipientUserId: order.user_id,
      recipientRole: "user",
      type: "order_vendor_rejected",
      title: "Order rejected",
      message: "The vendor could not accept this order. Please choose another listing or contact support.",
      relatedOrderId: order.id,
    });
  });

  log.info({ orderId, vendorUserId, action }, "Vendor order decision saved");
  return res.json({
    ok: true,
    order: {
      id: order.id,
      userId: order.user_id,
      status: order.status,
      updatedAt: order.updated_at,
    },
  });
});

router.patch("/:orderId/status", async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const statusRaw = typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : "";
  const log = req.log;

  if (!isValidStatus(statusRaw)) {
    return res.status(400).json({
      ok: false,
      message: `Invalid status. Allowed: ${ORDER_STATUSES.join(", ")}`,
    });
  }

  const { rows } = await query<{
    id: string;
    user_id: string;
    status: string;
    updated_at: string;
  }>(
    `UPDATE orders
     SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, user_id, status, updated_at`,
    [statusRaw, orderId],
  );
  const order = rows[0];

  if (!order) {
    return res.status(404).json({ ok: false, message: "Order not found" });
  }

  await safeNotify(log, async () => {
    await Promise.all([
      createNotification({
        recipientUserId: order.user_id,
        recipientRole: "user",
        type: "order_status_changed",
        title: "Order status updated",
        message: `Your order is now ${statusRaw.replace(/_/g, " ")}.`,
        relatedOrderId: order.id,
      }),
      notifyRole("admin", {
        type: "system_order_activity",
        title: "Order status changed",
        message: `Order ${order.id} changed to ${statusRaw.replace(/_/g, " ")}.`,
        relatedOrderId: order.id,
      }),
    ]);
  });

  log.info({ orderId, status: statusRaw }, "Order status updated");
  return res.json({
    ok: true,
    order: {
      id: order.id,
      userId: order.user_id,
      status: order.status,
      updatedAt: order.updated_at,
    },
  });
});

router.post("/:orderId/accept-delivery", async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const dispatcherId =
    typeof req.body?.dispatcherId === "string" ? req.body.dispatcherId.trim() : "";

  const { rows } = await query<{
    id: string;
    user_id: string;
    status: string;
    updated_at: string;
  }>(
    `UPDATE orders
     SET status = 'in_transit', updated_at = NOW()
     WHERE id = $1
     RETURNING id, user_id, status, updated_at`,
    [orderId],
  );
  const order = rows[0];

  if (!order) {
    return res.status(404).json({ ok: false, message: "Order not found" });
  }

  await safeNotify(req.log, async () => {
    await createNotification({
      recipientUserId: order.user_id,
      recipientRole: "user",
      type: "order_status_changed",
      title: "Order is in transit",
      message: "A dispatcher accepted delivery for your order.",
      relatedOrderId: order.id,
    });
  });

  return res.json({
    ok: true,
    order: {
      id: order.id,
      userId: order.user_id,
      status: order.status,
      updatedAt: order.updated_at,
    },
    dispatcherId: dispatcherId || null,
  });
});

router.get("/:orderId/tracking", async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const { rows } = await query<{
    id: string;
    user_id: string;
    status: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, user_id, status, created_at, updated_at
     FROM orders
     WHERE id = $1`,
    [orderId],
  );

  const order = rows[0];
  if (!order) {
    return res.status(404).json({ ok: false, message: "Order not found" });
  }

  const tracking = buildTrackingSteps(order.status);
  const etaMinutes = order.status === "in_transit" ? 25 : null;

  return res.json({
    ok: true,
    orderId: order.id,
    userId: order.user_id,
    status: order.status,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    etaMinutes,
    tracking,
  });
});

router.get("/:orderId", async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const { rows } = await query<{
    id: string;
    user_id: string;
    status: string;
    items: unknown;
  }>("SELECT id, user_id, status, items FROM orders WHERE id = $1", [orderId]);
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
