import { PoolClient } from "pg";
import { Request } from "express";
import { query, withClient } from "../db";
import { createNotification, notifyRole } from "./notifications";

export class CheckoutOrderError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type DbClient = Pick<PoolClient, "query">;

type AcceptedBargainRow = {
  id: string;
  part_id: string;
  buyer_user_id: string;
  vendor_user_id: string;
  status: string;
  accepted_price_ngn: number | null;
  used_order_id: string | null;
  current_price_ngn: number | null;
  part_name: string;
};

type PartPriceRow = {
  id: string;
  name: string;
  user_id: string | null;
  price_ngn: number | null;
  stock_qty: number | null;
};

type QuotePriceRow = {
  id: string;
  request_id: string;
  vendor_user_id: string;
  part_id: string | null;
  price_ngn: number;
  status: string;
  request_user_id: string;
  request_status: string;
  part_description: string | null;
  part_name: string | null;
  stock_qty: number | null;
};

export function genCheckoutId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function toObjectItem(item: unknown): Record<string, any> {
  return item && typeof item === "object" && !Array.isArray(item) ? { ...(item as Record<string, any>) } : {};
}

function requireString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeQuantity(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 99) {
    throw new CheckoutOrderError(400, "Quantity must be a whole number between 1 and 99.");
  }
  return numeric;
}

function normalizeNgnAmount(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new CheckoutOrderError(400, "A valid item price is required.");
  }
  return numeric;
}

async function ensureBargainOfferColumns(client: DbClient): Promise<void> {
  await client.query("ALTER TABLE bargain_offers ADD COLUMN IF NOT EXISTS accepted_price_ngn INTEGER");
  await client.query("ALTER TABLE bargain_offers ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ");
  await client.query("ALTER TABLE bargain_offers ADD COLUMN IF NOT EXISTS used_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL");
}

export async function normalizeCheckoutItems(
  client: DbClient,
  userId: string,
  rawItems: unknown[],
): Promise<Record<string, any>[]> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new CheckoutOrderError(400, "At least one item is required.");
  }

  await ensureBargainOfferColumns(client);
  const normalized: Record<string, any>[] = [];

  for (const rawItem of rawItems) {
    const item = toObjectItem(rawItem);
    const quantity = normalizeQuantity(item.quantity ?? 1);
    const bargainOfferId = requireString(item.bargainOfferId);
    const sourceQuoteId = requireString(item.sourceQuoteId);
    const sourceRequestId = requireString(item.sourceRequestId);

    if (bargainOfferId) {
      const requestedPartId = requireString(item.partId);
      const { rows } = await client.query<AcceptedBargainRow>(
        `SELECT
           bo.id,
           bo.part_id,
           bo.buyer_user_id,
           bo.vendor_user_id,
           bo.status,
           bo.accepted_price_ngn,
           bo.used_order_id,
           p.price_ngn AS current_price_ngn,
           p.name AS part_name
         FROM bargain_offers bo
         JOIN parts p ON p.id = bo.part_id
         WHERE bo.id = $1
         FOR UPDATE`,
        [bargainOfferId],
      );
      const offer = rows[0];

      if (!offer) {
        throw new CheckoutOrderError(400, "Accepted bargain offer was not found.");
      }
      if (offer.buyer_user_id !== userId) {
        throw new CheckoutOrderError(403, "This accepted bargain offer belongs to another buyer.");
      }
      if (offer.status !== "accepted" || !offer.accepted_price_ngn || offer.accepted_price_ngn <= 0) {
        throw new CheckoutOrderError(409, "This bargain offer has not been accepted yet.");
      }
      if (offer.used_order_id) {
        throw new CheckoutOrderError(409, "This accepted bargain offer has already been used for an order.");
      }
      if (requestedPartId && requestedPartId !== offer.part_id) {
        throw new CheckoutOrderError(400, "Accepted bargain offer does not match this part.");
      }

      normalized.push({
        ...item,
        partId: offer.part_id,
        name: requireString(item.name) || offer.part_name,
        quantity,
        unitPrice: offer.accepted_price_ngn,
        agreedPrice: offer.accepted_price_ngn,
        listedPrice: offer.current_price_ngn,
        bargainOfferId: offer.id,
        vendorUserId: offer.vendor_user_id,
        pricingSource: "accepted_bargain",
      });
      continue;
    }

    if (sourceQuoteId || sourceRequestId) {
      if (!sourceQuoteId || !sourceRequestId) {
        throw new CheckoutOrderError(400, "Quote checkout requires both quote and request ids.");
      }

      const { rows } = await client.query<QuotePriceRow>(
        `SELECT
           q.id,
           q.request_id,
           q.vendor_user_id,
           q.part_id,
           q.price_ngn,
           q.status,
           pr.user_id AS request_user_id,
           pr.status AS request_status,
           pr.part_description,
           p.name AS part_name,
           p.stock_qty
         FROM part_request_quotes q
         JOIN part_requests pr ON pr.id = q.request_id
         LEFT JOIN parts p ON p.id = q.part_id
         WHERE q.id = $1 AND q.request_id = $2
         FOR UPDATE OF q, pr`,
        [sourceQuoteId, sourceRequestId],
      );
      const quote = rows[0];

      if (!quote) {
        throw new CheckoutOrderError(404, "Quote was not found.");
      }
      if (quote.request_user_id !== userId) {
        throw new CheckoutOrderError(403, "This quote belongs to another buyer.");
      }
      if (["matched", "closed", "cancelled"].includes(quote.request_status)) {
        throw new CheckoutOrderError(409, "This request has already been closed.");
      }
      if (["rejected", "closed"].includes(quote.status)) {
        throw new CheckoutOrderError(409, "This quote is no longer available.");
      }
      if (typeof quote.stock_qty === "number" && quote.stock_qty >= 0 && quantity > quote.stock_qty) {
        throw new CheckoutOrderError(409, "Requested quantity is no longer available.");
      }

      normalized.push({
        ...item,
        partId: quote.part_id,
        name: quote.part_name || quote.part_description || requireString(item.name) || "Requested part",
        quantity,
        unitPrice: normalizeNgnAmount(quote.price_ngn),
        sourceRequestId: quote.request_id,
        sourceQuoteId: quote.id,
        vendorUserId: quote.vendor_user_id,
        pricingSource: "request_quote",
      });
      continue;
    }

    const partId = requireString(item.partId);
    if (!partId) {
      throw new CheckoutOrderError(400, "Each checkout item requires a part id.");
    }

    const { rows } = await client.query<PartPriceRow>(
      `SELECT id, name, user_id, price_ngn, stock_qty
       FROM parts
       WHERE id = $1
       LIMIT 1`,
      [partId],
    );
    const part = rows[0];
    if (!part) {
      throw new CheckoutOrderError(404, "A checkout item was not found.");
    }
    if (!part.price_ngn || part.price_ngn <= 0) {
      throw new CheckoutOrderError(409, "This part is not currently available for checkout.");
    }
    if (typeof part.stock_qty === "number" && part.stock_qty >= 0 && quantity > part.stock_qty) {
      throw new CheckoutOrderError(409, "Requested quantity is no longer available.");
    }

    normalized.push({
      ...item,
      partId: part.id,
      name: part.name,
      quantity,
      unitPrice: part.price_ngn,
      vendorUserId: part.user_id,
      pricingSource: "catalog",
    });
  }

  return normalized;
}

export function calculateCheckoutAmountKobo(items: Record<string, any>[]): number {
  const amountNgn = items.reduce((sum, item) => {
    const quantity = normalizeQuantity(item.quantity ?? 1);
    const unitPrice = normalizeNgnAmount(item.unitPrice);
    return sum + quantity * unitPrice;
  }, 0);
  return amountNgn * 100;
}

export async function insertOrderForCheckout(
  client: DbClient,
  input: { userId: string; items: Record<string, any>[]; orderId?: string },
): Promise<{ id: string; userId: string; items: Record<string, any>[]; status: "pending" }> {
  const id = input.orderId || genCheckoutId("ord");

  await client.query(
    "INSERT INTO orders (id, user_id, status, items) VALUES ($1, $2, $3, $4::jsonb)",
    [id, input.userId, "pending", JSON.stringify(input.items)],
  );

  const bargainOfferIds = input.items
    .map((item) => requireString(item.bargainOfferId))
    .filter(Boolean);
  for (const bargainOfferId of bargainOfferIds) {
    const result = await client.query(
      `UPDATE bargain_offers
       SET used_order_id = $1, updated_at = NOW()
       WHERE id = $2 AND used_order_id IS NULL`,
      [id, bargainOfferId],
    );
    if (!result.rowCount) {
      throw new CheckoutOrderError(409, "This accepted bargain offer has already been used for an order.");
    }
  }

  const firstQuoteId = requireString(input.items[0]?.sourceQuoteId);
  const firstRequestId = requireString(input.items[0]?.sourceRequestId);
  if (firstQuoteId && firstRequestId) {
    await client.query(
      `UPDATE part_request_quotes
       SET status = 'accepted', updated_at = NOW()
       WHERE id = $1 AND request_id = $2`,
      [firstQuoteId, firstRequestId],
    );
    await client.query(
      `UPDATE part_request_quotes
       SET status = CASE WHEN id = $1 THEN status ELSE 'closed' END,
           updated_at = NOW()
       WHERE request_id = $2`,
      [firstQuoteId, firstRequestId],
    );
    await client.query(
      `UPDATE part_requests
       SET status = 'matched'
       WHERE id = $1`,
      [firstRequestId],
    );
  }

  return { id, userId: input.userId, items: input.items, status: "pending" };
}

export async function notifyOrderCreated(
  log: Request["log"],
  input: { orderId: string; userId: string; items: Record<string, any>[] },
): Promise<void> {
  const partIds = Array.from(
    new Set(
      input.items
        .map((item: any) =>
          typeof item?.partId === "string" && item.partId.trim()
            ? item.partId.trim()
            : null,
        )
        .filter((partId: string | null): partId is string => partId !== null),
    ),
  );

  try {
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
              message: "A customer placed a paid order containing one of your parts. Accept or reject it from Orders.",
              relatedOrderId: input.orderId,
            }),
          ),
      );
    }

    await Promise.all([
      notifyRole("admin", {
        type: "system_order_activity",
        title: "New paid order created",
        message: "A new paid customer order was created.",
        relatedOrderId: input.orderId,
      }),
      createNotification({
        recipientUserId: input.userId,
        recipientRole: "user",
        type: "order_created",
        title: "Order placed",
        message: "Your payment was confirmed and your order is waiting for vendor confirmation.",
        relatedOrderId: input.orderId,
      }),
    ]);
  } catch (err) {
    log.warn({ err, orderId: input.orderId }, "Notification write failed");
  }
}

export async function createCheckoutOrder(input: {
  userId: string;
  rawItems: unknown[];
  log: Request["log"];
}): Promise<{ id: string; userId: string; items: Record<string, any>[]; status: "pending" }> {
  const order = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const items = await normalizeCheckoutItems(client, input.userId, input.rawItems);
      const created = await insertOrderForCheckout(client, { userId: input.userId, items });
      await client.query("COMMIT");
      return created;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });

  await notifyOrderCreated(input.log, {
    orderId: order.id,
    userId: order.userId,
    items: order.items,
  });

  return order;
}
