import { Router, Request, Response } from "express";
import { query, withClient } from "../db";
import { createNotification, notifyRole } from "../services/notifications";
import { CheckoutOrderError, createCheckoutOrder } from "../services/orderCheckout";
import { authenticateRequest, requireAuthenticated } from "../middleware/auth";
import { ensureVendorPickupLocationTable } from "./locations";
import {
  clearDeliveryRouteCache,
  getCachedDeliveryRoute,
  GoogleMapsServiceError,
} from "../services/googleMaps";

const router = Router();

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "ready_for_pickup",
  "accepted",
  "heading_to_pickup",
  "arrived_at_pickup",
  "picked_up",
  "heading_to_dropoff",
  "arrived_at_dropoff",
  "in_transit",
  "delivered",
  "cancelled",
  "rejected",
  "failed_delivery",
] as const;

type OrderStatus = (typeof ORDER_STATUSES)[number];

const DELIVERY_JOB_STATUSES = [
  "available",
  "accepted",
  "heading_to_pickup",
  "arrived_at_pickup",
  "picked_up",
  "heading_to_dropoff",
  "arrived_at_dropoff",
  "delivered",
  "cancelled",
  "failed",
] as const;

type DeliveryJobStatus = (typeof DELIVERY_JOB_STATUSES)[number];

function isValidStatus(value: string): value is OrderStatus {
  return ORDER_STATUSES.includes(value as OrderStatus);
}

function safeNotify(log: Request["log"], task: () => Promise<void>): void {
  task().catch((err) => {
    log.warn({ err }, "Notification write failed");
  });
}

function buildTrackingSteps(status: string) {
  const order = [
    "confirmed",
    "available",
    "accepted",
    "heading_to_pickup",
    "arrived_at_pickup",
    "picked_up",
    "heading_to_dropoff",
    "arrived_at_dropoff",
    "delivered",
  ];
  const activeIndex = Math.max(0, order.indexOf(status));

  const steps = [
    { key: "confirmed", title: "Order confirmed" },
    { key: "available", title: "Delivery available" },
    { key: "accepted", title: "Delivery accepted" },
    { key: "heading_to_pickup", title: "Heading to pickup" },
    { key: "arrived_at_pickup", title: "Arrived at pickup" },
    { key: "picked_up", title: "Picked up" },
    { key: "heading_to_dropoff", title: "Heading to dropoff" },
    { key: "arrived_at_dropoff", title: "Arrived at dropoff" },
    { key: "delivered", title: "Delivered" },
  ];

  return steps.map((step, index) => ({
    ...step,
    state:
      index < activeIndex ? "completed" : index === activeIndex ? "active" : "pending",
  }));
}

class OrderValidationError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type DbClient = {
  query: <T = any>(text: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
};

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

async function ensureBargainOfferColumns(client: DbClient): Promise<void> {
  await client.query("ALTER TABLE bargain_offers ADD COLUMN IF NOT EXISTS accepted_price_ngn INTEGER");
  await client.query("ALTER TABLE bargain_offers ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ");
  await client.query("ALTER TABLE bargain_offers ADD COLUMN IF NOT EXISTS used_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL");
}

async function ensureOrderDeliveryColumns(client: DbClient): Promise<void> {
  await client.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatcher_id TEXT REFERENCES users(id) ON DELETE SET NULL");
  await client.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ");
  await client.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_up_at TIMESTAMPTZ");
  await client.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ");
}

async function ensureDeliveryJobTable(client: DbClient): Promise<void> {
  await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT");
  await client.query(`
    CREATE TABLE IF NOT EXISTS delivery_jobs (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
      vendor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dispatcher_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      pickup_details TEXT,
      dropoff_details TEXT,
      status TEXT NOT NULL DEFAULT 'available',
      issue_note TEXT,
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ,
      heading_to_pickup_at TIMESTAMPTZ,
      arrived_at_pickup_at TIMESTAMPTZ,
      picked_up_at TIMESTAMPTZ,
      heading_to_dropoff_at TIMESTAMPTZ,
      arrived_at_dropoff_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ
    )
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_delivery_jobs_available ON delivery_jobs (status, created_at DESC) WHERE dispatcher_id IS NULL");
  await client.query("CREATE INDEX IF NOT EXISTS idx_delivery_jobs_dispatcher_status ON delivery_jobs (dispatcher_id, status, created_at DESC)");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS pickup_formatted_address TEXT");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS pickup_latitude DOUBLE PRECISION");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS pickup_longitude DOUBLE PRECISION");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS pickup_place_id TEXT");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS pickup_instructions TEXT");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS pickup_landmark TEXT");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS pickup_contact_name TEXT");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS pickup_contact_phone TEXT");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS dropoff_formatted_address TEXT");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS dropoff_latitude DOUBLE PRECISION");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS dropoff_longitude DOUBLE PRECISION");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS dropoff_place_id TEXT");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS dropoff_instructions TEXT");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS dropoff_landmark TEXT");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS dropoff_contact_name TEXT");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS dropoff_contact_phone TEXT");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS dispatcher_latest_latitude DOUBLE PRECISION");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS dispatcher_latest_longitude DOUBLE PRECISION");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS dispatcher_location_updated_at TIMESTAMPTZ");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS dispatcher_heading DOUBLE PRECISION");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS dispatcher_speed DOUBLE PRECISION");
  await client.query("ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS tracking_status TEXT");
  await client.query("CREATE INDEX IF NOT EXISTS idx_delivery_jobs_order_tracking ON delivery_jobs (order_id, dispatcher_id, status)");
}

const DISPATCHER_ACTIVE_STATUSES = [
  "accepted",
  "heading_to_pickup",
  "arrived_at_pickup",
  "picked_up",
  "heading_to_dropoff",
  "arrived_at_dropoff",
];
const DISPATCHER_HISTORY_STATUSES = ["delivered", "cancelled", "failed"];
const DISPATCHER_TRANSITIONS: Record<string, string[]> = {
  available: ["accepted"],
  assigned: ["accepted"],
  confirmed: ["accepted"],
  ready_for_pickup: ["accepted"],
  accepted: ["heading_to_pickup", "cancelled", "failed"],
  heading_to_pickup: ["arrived_at_pickup", "cancelled", "failed"],
  arrived_at_pickup: ["picked_up", "cancelled", "failed"],
  picked_up: ["heading_to_dropoff", "cancelled", "failed"],
  heading_to_dropoff: ["arrived_at_dropoff", "cancelled", "failed"],
  arrived_at_dropoff: ["delivered", "failed"],
};

function toObjectItem(item: unknown): Record<string, any> {
  return item && typeof item === "object" && !Array.isArray(item) ? { ...(item as Record<string, any>) } : {};
}

function requireString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isDeliveryJobStatus(value: string): value is DeliveryJobStatus {
  return DELIVERY_JOB_STATUSES.includes(value as DeliveryJobStatus);
}

function deliveryStatusToOrderStatus(status: DeliveryJobStatus): OrderStatus {
  if (status === "failed") return "failed_delivery";
  if (status === "available") return "confirmed";
  return status;
}

function summarizeItems(items: unknown): { itemCount: number; orderSummary: string } {
  const rows = Array.isArray(items) ? items : [];
  const names = rows
    .map((item: any) => (typeof item?.name === "string" && item.name.trim() ? item.name.trim() : "Part"))
    .slice(0, 2);
  return {
    itemCount: rows.length,
    orderSummary: names.length ? names.join(", ") : "Spare parts order",
  };
}

function extractDeliveryLocation(items: unknown): {
  formattedAddress: string;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
  instructions: string | null;
  landmark: string | null;
} | null {
  const rows = Array.isArray(items) ? items : [];
  for (const item of rows) {
    const location =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, any>).deliveryLocation
        : null;
    if (!location || typeof location !== "object" || Array.isArray(location)) continue;

    const formattedAddress = requireString((location as Record<string, any>).formattedAddress);
    const latitude = readOptionalNumber((location as Record<string, any>).latitude);
    const longitude = readOptionalNumber((location as Record<string, any>).longitude);
    if (!formattedAddress && (latitude === null || longitude === null)) continue;

    return {
      formattedAddress,
      latitude: latitude !== null && isFiniteLatitude(latitude) ? latitude : null,
      longitude: longitude !== null && isFiniteLongitude(longitude) ? longitude : null,
      placeId: requireString((location as Record<string, any>).placeId) || null,
      instructions: requireString((location as Record<string, any>).instructions) || null,
      landmark: requireString((location as Record<string, any>).landmark) || null,
    };
  }
  return null;
}

async function getVendorDisplayName(client: DbClient, vendorUserId: string): Promise<string> {
  const { rows } = await client.query<{ vendor_name: string | null }>(
    `SELECT COALESCE(NULLIF(first_name, ''), split_part(email, '@', 1), 'Vendor') AS vendor_name
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [vendorUserId],
  );
  return rows[0]?.vendor_name || "Vendor pickup";
}

async function orderContainsVendorPartWithClient(
  client: DbClient,
  orderId: string,
  vendorUserId: string,
): Promise<boolean> {
  const orderResult = await client.query<{ items: unknown }>(
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

  const partResult = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM parts
     WHERE user_id = $1 AND id = ANY($2::text[])`,
    [vendorUserId, partIds],
  );
  return Number.parseInt(partResult.rows[0]?.count ?? "0", 10) > 0;
}

type DeliveryJobRow = {
  delivery_job_id: string;
  order_id: string;
  vendor_id: string | null;
  customer_id: string;
  dispatcher_id: string | null;
  delivery_status: string;
  order_status: string;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  pickup_details: string | null;
  dropoff_details: string | null;
  pickup_formatted_address?: string | null;
  pickup_latitude?: number | null;
  pickup_longitude?: number | null;
  pickup_place_id?: string | null;
  pickup_instructions?: string | null;
  pickup_landmark?: string | null;
  pickup_contact_name?: string | null;
  pickup_contact_phone?: string | null;
  dropoff_formatted_address?: string | null;
  dropoff_latitude?: number | null;
  dropoff_longitude?: number | null;
  dropoff_place_id?: string | null;
  dropoff_instructions?: string | null;
  dropoff_landmark?: string | null;
  dropoff_contact_name?: string | null;
  dropoff_contact_phone?: string | null;
  dispatcher_latest_latitude?: number | null;
  dispatcher_latest_longitude?: number | null;
  dispatcher_location_updated_at?: string | null;
  dispatcher_heading?: number | null;
  dispatcher_speed?: number | null;
  tracking_status?: string | null;
  issue_note: string | null;
  failure_reason: string | null;
  items: unknown;
  buyer_name: string | null;
  vendor_name: string | null;
  dispatcher_name?: string | null;
  dispatcher_phone?: string | null;
};

function isFiniteLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function isFiniteLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

function readOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mapStructuredLocation(input: {
  details?: string | null;
  formattedAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  placeId?: string | null;
  instructions?: string | null;
  landmark?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
}) {
  const latitude = typeof input.latitude === "number" ? input.latitude : null;
  const longitude = typeof input.longitude === "number" ? input.longitude : null;
  return {
    formattedAddress: input.formattedAddress || input.details || "",
    latitude: latitude !== null && isFiniteLatitude(latitude) ? latitude : null,
    longitude: longitude !== null && isFiniteLongitude(longitude) ? longitude : null,
    placeId: input.placeId || null,
    instructions: input.instructions || null,
    landmark: input.landmark || null,
    contactName: input.contactName || null,
    contactPhone: input.contactPhone || null,
  };
}

function canViewTracking(user: { id: string; role: string }, order: {
  user_id: string;
  vendor_id: string | null;
  dispatcher_id: string | null;
}): boolean {
  if (["admin", "staff"].includes(user.role)) return true;
  if (user.id === order.user_id) return true;
  if (order.vendor_id && user.id === order.vendor_id) return true;
  if (order.dispatcher_id && user.id === order.dispatcher_id) return true;
  return false;
}

function mapDeliveryJob(row: DeliveryJobRow, dispatcherId?: string) {
  const isAssignedToCurrentDispatcher =
    Boolean(dispatcherId) && row.dispatcher_id === dispatcherId;
  const isAvailable = row.delivery_status === "available" && !row.dispatcher_id;
  const items = Array.isArray(row.items) ? row.items : [];
  const { itemCount, orderSummary } = summarizeItems(items);

  return {
    id: row.order_id,
    orderId: row.order_id,
    deliveryJobId: row.delivery_job_id,
    userId: row.customer_id,
    customerId: row.customer_id,
    vendorId: row.vendor_id,
    dispatcherId: row.dispatcher_id,
    status: row.delivery_status,
    orderStatus: row.order_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
    pickedUpAt: row.picked_up_at,
    deliveredAt: row.delivered_at,
    buyerName: isAssignedToCurrentDispatcher ? row.buyer_name : null,
    vendorName: row.vendor_name || "Vendor",
    pickupDetails: row.pickup_details || row.vendor_name || "Vendor pickup",
    dropoffDetails:
      isAssignedToCurrentDispatcher || !isAvailable
        ? row.dropoff_details || "Customer dropoff"
        : "Customer dropoff area",
    pickupLocation: mapStructuredLocation({
      details: row.pickup_details,
      formattedAddress: row.pickup_formatted_address,
      latitude: row.pickup_latitude,
      longitude: row.pickup_longitude,
      placeId: row.pickup_place_id,
      instructions: row.pickup_instructions,
      landmark: row.pickup_landmark,
      contactName: row.pickup_contact_name || row.vendor_name,
      contactPhone: row.pickup_contact_phone,
    }),
    dropoffLocation:
      isAssignedToCurrentDispatcher || !isAvailable
        ? mapStructuredLocation({
            details: row.dropoff_details,
            formattedAddress: row.dropoff_formatted_address,
            latitude: row.dropoff_latitude,
            longitude: row.dropoff_longitude,
            placeId: row.dropoff_place_id,
            instructions: row.dropoff_instructions,
            landmark: row.dropoff_landmark,
            contactName: row.dropoff_contact_name || row.buyer_name,
            contactPhone: row.dropoff_contact_phone,
          })
        : null,
    itemCount,
    orderSummary,
    items,
    issueNote: row.issue_note,
    failureReason: row.failure_reason,
  };
}

async function createAvailableDeliveryJob(
  client: DbClient,
  input: { orderId: string; vendorUserId: string; customerId: string },
): Promise<{ id: string; pickupDetails: string; dropoffDetails: string; orderSummary: string; itemCount: number }> {
  await ensureDeliveryJobTable(client);
  await ensureVendorPickupLocationTable(client);

  const pickupResult = await client.query<{
    formatted_address: string;
    latitude: number;
    longitude: number;
    place_id: string | null;
    instructions: string | null;
    landmark: string | null;
  }>(
    `SELECT formatted_address, latitude, longitude, place_id, instructions, landmark
     FROM vendor_pickup_locations
     WHERE vendor_id = $1
     LIMIT 1`,
    [input.vendorUserId],
  );
  const pickupLocation = pickupResult.rows[0];
  if (!pickupLocation) {
    throw new OrderValidationError(409, "Set a pickup location before accepting this order.");
  }

  const vendorName = await getVendorDisplayName(client, input.vendorUserId);
  const orderResult = await client.query<{
    items: unknown;
    buyer_name: string | null;
    buyer_phone: string | null;
    vendor_name: string | null;
    vendor_phone: string | null;
  }>(
    `SELECT
       o.items,
       COALESCE(NULLIF(c.first_name, ''), split_part(c.email, '@', 1)) AS buyer_name,
       c.phone AS buyer_phone,
       COALESCE(NULLIF(v.first_name, ''), split_part(v.email, '@', 1)) AS vendor_name,
       v.phone AS vendor_phone
     FROM orders o
     LEFT JOIN users c ON c.id = o.user_id
     LEFT JOIN users v ON v.id = $2
     WHERE o.id = $1
     LIMIT 1`,
    [input.orderId, input.vendorUserId],
  );
  const { itemCount, orderSummary } = summarizeItems(orderResult.rows[0]?.items);
  const deliveryLocation = extractDeliveryLocation(orderResult.rows[0]?.items);
  const pickupDetails = `${vendorName} pickup`;
  const dropoffDetails = deliveryLocation?.formattedAddress || "Customer dropoff";
  const deliveryJobId = genId("djob");

  const insertResult = await client.query<{ id: string }>(
    `INSERT INTO delivery_jobs
       (
         id,
         order_id,
         vendor_id,
         customer_id,
         pickup_details,
         dropoff_details,
         pickup_formatted_address,
         pickup_latitude,
         pickup_longitude,
         pickup_place_id,
         pickup_instructions,
         pickup_landmark,
         pickup_contact_name,
         pickup_contact_phone,
         dropoff_formatted_address,
         dropoff_latitude,
         dropoff_longitude,
         dropoff_place_id,
         dropoff_instructions,
         dropoff_landmark,
         dropoff_contact_name,
         dropoff_contact_phone,
         status
       )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, 'available')
     ON CONFLICT (order_id) DO UPDATE SET
       vendor_id = EXCLUDED.vendor_id,
       customer_id = EXCLUDED.customer_id,
       pickup_details = EXCLUDED.pickup_details,
       dropoff_details = EXCLUDED.dropoff_details,
       pickup_formatted_address = EXCLUDED.pickup_formatted_address,
       pickup_latitude = EXCLUDED.pickup_latitude,
       pickup_longitude = EXCLUDED.pickup_longitude,
       pickup_place_id = EXCLUDED.pickup_place_id,
       pickup_instructions = EXCLUDED.pickup_instructions,
       pickup_landmark = EXCLUDED.pickup_landmark,
       pickup_contact_name = COALESCE(delivery_jobs.pickup_contact_name, EXCLUDED.pickup_contact_name),
       pickup_contact_phone = COALESCE(delivery_jobs.pickup_contact_phone, EXCLUDED.pickup_contact_phone),
       dropoff_formatted_address = COALESCE(delivery_jobs.dropoff_formatted_address, EXCLUDED.dropoff_formatted_address),
       dropoff_latitude = COALESCE(delivery_jobs.dropoff_latitude, EXCLUDED.dropoff_latitude),
       dropoff_longitude = COALESCE(delivery_jobs.dropoff_longitude, EXCLUDED.dropoff_longitude),
       dropoff_place_id = COALESCE(delivery_jobs.dropoff_place_id, EXCLUDED.dropoff_place_id),
       dropoff_instructions = COALESCE(delivery_jobs.dropoff_instructions, EXCLUDED.dropoff_instructions),
       dropoff_landmark = COALESCE(delivery_jobs.dropoff_landmark, EXCLUDED.dropoff_landmark),
       dropoff_contact_name = COALESCE(delivery_jobs.dropoff_contact_name, EXCLUDED.dropoff_contact_name),
       dropoff_contact_phone = COALESCE(delivery_jobs.dropoff_contact_phone, EXCLUDED.dropoff_contact_phone),
       status = CASE
         WHEN delivery_jobs.dispatcher_id IS NULL AND delivery_jobs.status IN ('available', 'cancelled', 'failed')
           THEN 'available'
         ELSE delivery_jobs.status
       END,
       updated_at = NOW()
     RETURNING id`,
    [
      deliveryJobId,
      input.orderId,
      input.vendorUserId,
      input.customerId,
      pickupDetails,
      dropoffDetails,
      pickupLocation.formatted_address,
      pickupLocation.latitude,
      pickupLocation.longitude,
      pickupLocation.place_id,
      pickupLocation.instructions,
      pickupLocation.landmark,
      orderResult.rows[0]?.vendor_name || vendorName,
      orderResult.rows[0]?.vendor_phone || null,
      deliveryLocation?.formattedAddress || null,
      deliveryLocation?.latitude ?? null,
      deliveryLocation?.longitude ?? null,
      deliveryLocation?.placeId ?? null,
      deliveryLocation?.instructions ?? null,
      deliveryLocation?.landmark ?? null,
      orderResult.rows[0]?.buyer_name || null,
      orderResult.rows[0]?.buyer_phone || null,
    ],
  );

  return {
    id: insertResult.rows[0]?.id || deliveryJobId,
    pickupDetails,
    dropoffDetails,
    orderSummary,
    itemCount,
  };
}

async function normalizeOrderItems(client: DbClient, userId: string, rawItems: unknown[]): Promise<Record<string, any>[]> {
  const normalized: Record<string, any>[] = [];

  for (const rawItem of rawItems) {
    const item = toObjectItem(rawItem);
    const bargainOfferId = requireString(item.bargainOfferId);
    if (!bargainOfferId) {
      normalized.push(item);
      continue;
    }

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
      throw new OrderValidationError(400, "Accepted bargain offer was not found.");
    }
    if (offer.buyer_user_id !== userId) {
      throw new OrderValidationError(403, "This accepted bargain offer belongs to another buyer.");
    }
    if (offer.status !== "accepted" || !offer.accepted_price_ngn || offer.accepted_price_ngn <= 0) {
      throw new OrderValidationError(409, "This bargain offer has not been accepted yet.");
    }
    if (offer.used_order_id) {
      throw new OrderValidationError(409, "This accepted bargain offer has already been used for an order.");
    }
    if (requestedPartId && requestedPartId !== offer.part_id) {
      throw new OrderValidationError(400, "Accepted bargain offer does not match this part.");
    }

    normalized.push({
      ...item,
      partId: offer.part_id,
      name: requireString(item.name) || offer.part_name,
      unitPrice: offer.accepted_price_ngn,
      agreedPrice: offer.accepted_price_ngn,
      listedPrice: offer.current_price_ngn,
      bargainOfferId: offer.id,
      pricingSource: "accepted_bargain",
    });
  }

  return normalized;
}

router.post("/", async (req: Request, res: Response) => {
  const log = req.log;
  const { userId, items } = req.body as { userId?: string; items?: unknown[] };

  if (!userId) {
    return res.status(400).json({ ok: false, message: "userId is required" });
  }

  const rawItems = Array.isArray(items) ? items : [];

  try {
    const order = await createCheckoutOrder({ userId, rawItems, log });

    log.info({ orderId: order.id, userId }, "Order created");
    return res.status(201).json({
      id: order.id,
      userId,
      items: order.items,
      status: order.status,
    });
  } catch (err) {
    if (err instanceof CheckoutOrderError || err instanceof OrderValidationError) {
      return res.status(err.status).json({ ok: false, message: err.message });
    }
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

router.get("/pending", requireAuthenticated, async (req: Request, res: Response) => {
  if (!req.user || !["dispatcher", "admin", "staff"].includes(req.user.role)) {
    return res.status(403).json({ ok: false, message: "Not authorized" });
  }

  const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 20;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
  await ensureDeliveryJobTable({ query } as unknown as DbClient);
  const { rows } = await query<DeliveryJobRow>(
    `SELECT
       dj.id AS delivery_job_id,
       dj.order_id,
       dj.vendor_id,
       dj.customer_id,
       dj.dispatcher_id,
       dj.status AS delivery_status,
       o.status AS order_status,
       dj.created_at,
       dj.updated_at,
       dj.accepted_at,
       dj.picked_up_at,
       dj.delivered_at,
       dj.pickup_details,
       dj.dropoff_details,
       dj.pickup_formatted_address,
       dj.pickup_latitude,
       dj.pickup_longitude,
       dj.pickup_place_id,
       dj.pickup_instructions,
       dj.pickup_landmark,
       dj.pickup_contact_name,
       dj.pickup_contact_phone,
       dj.dropoff_formatted_address,
       dj.dropoff_latitude,
       dj.dropoff_longitude,
       dj.dropoff_place_id,
       dj.dropoff_instructions,
       dj.dropoff_landmark,
       dj.dropoff_contact_name,
       dj.dropoff_contact_phone,
       dj.issue_note,
       dj.failure_reason,
       o.items,
       COALESCE(NULLIF(c.first_name, ''), split_part(c.email, '@', 1)) AS buyer_name,
       COALESCE(NULLIF(v.first_name, ''), split_part(v.email, '@', 1)) AS vendor_name
     FROM delivery_jobs dj
     JOIN orders o ON o.id = dj.order_id
     LEFT JOIN users c ON c.id = dj.customer_id
     LEFT JOIN users v ON v.id = dj.vendor_id
     WHERE dj.status = 'available'
       AND dj.dispatcher_id IS NULL
     ORDER BY dj.created_at DESC
     LIMIT $1`,
    [limit],
  );

  return res.json({
    ok: true,
    orders: rows.map((order) => mapDeliveryJob(order)),
  });
});

router.get("/dispatcher/:dispatcherId/jobs", requireAuthenticated, async (req: Request, res: Response) => {
  const dispatcherId = typeof req.params.dispatcherId === "string" ? req.params.dispatcherId.trim() : "";
  if (!dispatcherId) {
    return res.status(400).json({ ok: false, message: "dispatcherId is required" });
  }
  if (
    !req.user ||
    (req.user.id !== dispatcherId && !["admin", "staff"].includes(req.user.role)) ||
    (req.user.role !== "dispatcher" && !["admin", "staff"].includes(req.user.role))
  ) {
    return res.status(403).json({ ok: false, message: "Not authorized to view these delivery jobs" });
  }

  await ensureOrderDeliveryColumns({ query } as unknown as DbClient);
  await ensureDeliveryJobTable({ query } as unknown as DbClient);
  const { rows } = await query<DeliveryJobRow>(
    `SELECT
       dj.id AS delivery_job_id,
       dj.order_id,
       dj.vendor_id,
       dj.customer_id,
       dj.dispatcher_id,
       dj.status AS delivery_status,
       o.status AS order_status,
       dj.created_at,
       dj.updated_at,
       dj.accepted_at,
       dj.picked_up_at,
       dj.delivered_at,
       dj.pickup_details,
       dj.dropoff_details,
       dj.pickup_formatted_address,
       dj.pickup_latitude,
       dj.pickup_longitude,
       dj.pickup_place_id,
       dj.pickup_instructions,
       dj.pickup_landmark,
       dj.pickup_contact_name,
       dj.pickup_contact_phone,
       dj.dropoff_formatted_address,
       dj.dropoff_latitude,
       dj.dropoff_longitude,
       dj.dropoff_place_id,
       dj.dropoff_instructions,
       dj.dropoff_landmark,
       dj.dropoff_contact_name,
       dj.dropoff_contact_phone,
       dj.issue_note,
       dj.failure_reason,
       o.items,
       COALESCE(NULLIF(c.first_name, ''), split_part(c.email, '@', 1)) AS buyer_name,
       COALESCE(NULLIF(v.first_name, ''), split_part(v.email, '@', 1)) AS vendor_name
     FROM delivery_jobs dj
     JOIN orders o ON o.id = dj.order_id
     LEFT JOIN users c ON c.id = dj.customer_id
     LEFT JOIN users v ON v.id = dj.vendor_id
     WHERE (dj.status = 'available' AND dj.dispatcher_id IS NULL)
        OR (dj.dispatcher_id = $1 AND dj.status = ANY($2::text[]))
        OR (dj.dispatcher_id = $1 AND dj.status = ANY($3::text[]))
     ORDER BY dj.created_at DESC
     LIMIT 100`,
    [dispatcherId, DISPATCHER_ACTIVE_STATUSES, DISPATCHER_HISTORY_STATUSES],
  );

  const jobs = rows.map((row) => mapDeliveryJob(row, dispatcherId));
  return res.json({
    ok: true,
    available: jobs.filter((job) => job.status === "available" && !job.dispatcherId),
    active: jobs.filter((job) => job.dispatcherId === dispatcherId && DISPATCHER_ACTIVE_STATUSES.includes(job.status)),
    history: jobs.filter((job) => job.dispatcherId === dispatcherId && DISPATCHER_HISTORY_STATUSES.includes(job.status)),
  });
});

router.get("/dispatcher/:dispatcherId/jobs/legacy", async (req: Request, res: Response) => {
  const dispatcherId = typeof req.params.dispatcherId === "string" ? req.params.dispatcherId.trim() : "";
  if (!dispatcherId) {
    return res.status(400).json({ ok: false, message: "dispatcherId is required" });
  }

  await ensureOrderDeliveryColumns({ query } as unknown as DbClient);
  const { rows } = await query<{
    id: string;
    user_id: string;
    status: string;
    created_at: string;
    updated_at: string;
    items: unknown;
    buyer_name: string | null;
    dispatcher_id: string | null;
  }>(
    `SELECT
       o.id,
       o.user_id,
       o.status,
       o.created_at,
       o.updated_at,
       o.items,
       o.dispatcher_id,
       COALESCE(NULLIF(u.first_name, ''), split_part(u.email, '@', 1)) AS buyer_name
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     WHERE (o.status = ANY($1::text[]) AND o.dispatcher_id IS NULL)
        OR (o.dispatcher_id = $2 AND o.status = ANY($3::text[]))
        OR (o.dispatcher_id = $2 AND o.status = ANY($4::text[]))
     ORDER BY o.created_at DESC
     LIMIT 100`,
    [["confirmed", "ready_for_pickup"], dispatcherId, DISPATCHER_ACTIVE_STATUSES, ["delivered", "cancelled", "failed_delivery"]],
  );

  const mapOrder = (order: typeof rows[number]) => ({
    id: order.id,
    orderId: order.id,
    userId: order.user_id,
    buyerName: order.buyer_name,
    status: order.status,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    dispatcherId: order.dispatcher_id,
    items: Array.isArray(order.items) ? order.items : [],
    itemCount: Array.isArray(order.items) ? order.items.length : 0,
  });

  const orders = rows.map(mapOrder);
  return res.json({
    ok: true,
    available: orders.filter((order) => !order.dispatcherId),
    active: orders.filter((order) => order.dispatcherId === dispatcherId && DISPATCHER_ACTIVE_STATUSES.includes(order.status)),
    history: orders.filter((order) => order.dispatcherId === dispatcherId && ["delivered", "cancelled", "failed_delivery"].includes(order.status)),
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

router.post("/:orderId/vendor-decision", requireAuthenticated, async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const log = req.log;
  const requestedVendorId = typeof req.body?.vendorUserId === "string" ? req.body.vendorUserId.trim() : "";
  const vendorUserId =
    req.user?.role === "vendor"
      ? req.user.id
      : ["admin", "staff"].includes(req.user?.role || "")
        ? requestedVendorId
        : "";
  const action = typeof req.body?.action === "string" ? req.body.action.trim().toLowerCase() : "";

  if (!req.user || !["vendor", "admin", "staff"].includes(req.user.role)) {
    return res.status(403).json({ ok: false, message: "Only vendors can review vendor orders" });
  }
  if (!vendorUserId) {
    return res.status(400).json({ ok: false, message: "vendorUserId is required" });
  }
  if (!["accept", "reject"].includes(action)) {
    return res.status(400).json({ ok: false, message: "Action must be accept or reject" });
  }

  const nextStatus = action === "accept" ? "confirmed" : "cancelled";
  const result = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await ensureOrderDeliveryColumns(client);
      await ensureDeliveryJobTable(client);
      await ensureVendorPickupLocationTable(client);

      const isVendorOrder = await orderContainsVendorPartWithClient(client, orderId, vendorUserId);
      if (!isVendorOrder) {
        await client.query("ROLLBACK");
        return {
          errorStatus: 403,
          errorMessage: "This order is not linked to your vendor inventory",
        };
      }

      if (action === "accept") {
        const pickupResult = await client.query<{ vendor_id: string }>(
          `SELECT vendor_id
           FROM vendor_pickup_locations
           WHERE vendor_id = $1
             AND latitude BETWEEN -90 AND 90
             AND longitude BETWEEN -180 AND 180
           LIMIT 1`,
          [vendorUserId],
        );
        if (!pickupResult.rows[0]) {
          await client.query("ROLLBACK");
          return {
            errorStatus: 409,
            errorCode: "VENDOR_PICKUP_LOCATION_REQUIRED",
            errorMessage: "Set a pickup location before accepting this order.",
          };
        }
      }

      const { rows } = await client.query<{ id: string; user_id: string; status: string; updated_at: string }>(
        `UPDATE orders
         SET status = $1, updated_at = NOW()
         WHERE id = $2 AND status = 'pending'
         RETURNING id, user_id, status, updated_at`,
        [nextStatus, orderId],
      );
      const order = rows[0];

      if (!order) {
        await client.query("ROLLBACK");
        return {
          errorStatus: 409,
          errorMessage: "Order is no longer waiting for vendor review",
        };
      }

      const deliveryJob =
        action === "accept"
          ? await createAvailableDeliveryJob(client, {
              orderId: order.id,
              vendorUserId,
              customerId: order.user_id,
            })
          : null;

      await client.query("COMMIT");
      return { order, deliveryJob };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });

  if ("errorStatus" in result) {
    return res.status(result.errorStatus ?? 500).json({
      ok: false,
      code: "errorCode" in result ? result.errorCode : undefined,
      message: result.errorMessage,
    });
  }

  const { order, deliveryJob } = result;

  safeNotify(log, async () => {
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
        // TODO: Replace role-wide fan-out with nearest-dispatcher targeting using dispatcher location and vendor pickup location.
        notifyRole("dispatcher", {
          type: "dispatch_job_available",
          title: "New Delivery Available",
          message: deliveryJob
            ? `Pickup from ${deliveryJob.pickupDetails} and deliver to customer dropoff.`
            : "A vendor accepted an order that needs delivery coordination.",
          relatedOrderId: order.id,
          relatedJobId: deliveryJob?.id,
          data: deliveryJob
            ? {
                pickupDetails: deliveryJob.pickupDetails,
                dropoffDetails: "Customer dropoff area",
                orderSummary: deliveryJob.orderSummary,
                itemCount: deliveryJob.itemCount,
              }
            : undefined,
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

router.post("/:orderId/accept-delivery", requireAuthenticated, async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const dispatcherId = req.user?.role === "dispatcher" ? req.user.id : "";

  if (!dispatcherId) {
    return res.status(403).json({ ok: false, message: "Only dispatchers can accept delivery jobs" });
  }

  const result = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await ensureOrderDeliveryColumns(client);
      await ensureDeliveryJobTable(client);

      const dispatcherResult = await client.query<{ role: string }>(
        `SELECT role FROM users WHERE id = $1 LIMIT 1`,
        [dispatcherId],
      );
      if (dispatcherResult.rows[0]?.role !== "dispatcher") {
        await client.query("ROLLBACK");
        return {
          errorStatus: 403,
          errorMessage: "Only dispatchers can accept delivery jobs",
        };
      }

      const { rows } = await client.query<{
        id: string;
        order_id: string;
        customer_id: string;
        status: string;
        dispatcher_id: string | null;
        updated_at: string;
      }>(
        `UPDATE delivery_jobs
         SET status = 'accepted',
             dispatcher_id = $1,
             accepted_at = NOW(),
             tracking_status = 'assigned',
             updated_at = NOW()
         WHERE order_id = $2
           AND dispatcher_id IS NULL
           AND status = 'available'
         RETURNING id, order_id, customer_id, status, dispatcher_id, updated_at`,
        [dispatcherId, orderId],
      );
      const job = rows[0];

      if (!job) {
        await client.query("ROLLBACK");
        return {
          errorStatus: 409,
          errorMessage: "This delivery has already been accepted by another dispatcher.",
        };
      }

      const orderResult = await client.query<{ id: string; user_id: string; status: string; updated_at: string }>(
        `UPDATE orders
         SET status = 'accepted',
             dispatcher_id = $1,
             accepted_at = NOW(),
             updated_at = NOW()
         WHERE id = $2
         RETURNING id, user_id, status, updated_at`,
        [dispatcherId, orderId],
      );
      await client.query("COMMIT");
      return { job, order: orderResult.rows[0] };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });

  if ("errorStatus" in result) {
    return res.status(result.errorStatus ?? 500).json({ ok: false, message: result.errorMessage });
  }

  const { job, order } = result;

  safeNotify(req.log, async () => {
    await createNotification({
      recipientUserId: order.user_id,
      recipientRole: "user",
      type: "order_status_changed",
      title: "Delivery accepted",
      message: "A dispatcher accepted delivery for your order.",
      relatedOrderId: order.id,
      relatedJobId: job.id,
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
    deliveryJob: {
      id: job.id,
      orderId: job.order_id,
      status: job.status,
      dispatcherId: job.dispatcher_id,
      updatedAt: job.updated_at,
    },
    dispatcherId: job.dispatcher_id,
  });
});

router.post("/:orderId/dispatcher-status", requireAuthenticated, async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const log = req.log;
  const dispatcherId = req.user?.role === "dispatcher" ? req.user.id : "";
  const nextStatus = typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : "";
  const issueNote = typeof req.body?.issueNote === "string" ? req.body.issueNote.trim().slice(0, 500) : "";

  if (!dispatcherId) {
    return res.status(403).json({ ok: false, message: "Only dispatchers can update delivery status" });
  }
  if (!nextStatus || !isDeliveryJobStatus(nextStatus)) {
    return res.status(400).json({ ok: false, message: "Invalid dispatcher status" });
  }

  const result = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await ensureOrderDeliveryColumns(client);
      await ensureDeliveryJobTable(client);

      const currentResult = await client.query<{
        id: string;
        order_id: string;
        customer_id: string;
        status: string;
        dispatcher_id: string | null;
      }>(
        `SELECT id, order_id, customer_id, status, dispatcher_id
         FROM delivery_jobs
         WHERE order_id = $1
         FOR UPDATE`,
        [orderId],
      );
      const current = currentResult.rows[0];

      if (!current) {
        await client.query("ROLLBACK");
        return { errorStatus: 404, errorMessage: "Delivery job not found" };
      }
      if (current.dispatcher_id !== dispatcherId) {
        await client.query("ROLLBACK");
        return { errorStatus: 403, errorMessage: "This delivery is assigned to another dispatcher" };
      }
      if (!DISPATCHER_TRANSITIONS[current.status]?.includes(nextStatus)) {
        await client.query("ROLLBACK");
        return { errorStatus: 409, errorMessage: `Cannot move delivery from ${current.status} to ${nextStatus}` };
      }

      const jobResult = await client.query<{
        id: string;
        order_id: string;
        customer_id: string;
        vendor_id: string | null;
        status: string;
        updated_at: string;
      }>(
        `UPDATE delivery_jobs
         SET status = $1,
             issue_note = CASE WHEN $1 IN ('failed', 'cancelled') AND $5 <> '' THEN $5 ELSE issue_note END,
             failure_reason = CASE WHEN $1 = 'failed' AND $5 <> '' THEN $5 ELSE failure_reason END,
             heading_to_pickup_at = CASE WHEN $1 = 'heading_to_pickup' THEN NOW() ELSE heading_to_pickup_at END,
             arrived_at_pickup_at = CASE WHEN $1 = 'arrived_at_pickup' THEN NOW() ELSE arrived_at_pickup_at END,
             picked_up_at = CASE WHEN $1 = 'picked_up' THEN NOW() ELSE picked_up_at END,
             heading_to_dropoff_at = CASE WHEN $1 = 'heading_to_dropoff' THEN NOW() ELSE heading_to_dropoff_at END,
             arrived_at_dropoff_at = CASE WHEN $1 = 'arrived_at_dropoff' THEN NOW() ELSE arrived_at_dropoff_at END,
             delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END,
             cancelled_at = CASE WHEN $1 = 'cancelled' THEN NOW() ELSE cancelled_at END,
             failed_at = CASE WHEN $1 = 'failed' THEN NOW() ELSE failed_at END,
             tracking_status = CASE WHEN $1 IN ('delivered', 'cancelled', 'failed') THEN 'stopped' ELSE COALESCE(tracking_status, 'live') END,
             dispatcher_latest_latitude = CASE WHEN $1 IN ('delivered', 'cancelled', 'failed') THEN NULL ELSE dispatcher_latest_latitude END,
             dispatcher_latest_longitude = CASE WHEN $1 IN ('delivered', 'cancelled', 'failed') THEN NULL ELSE dispatcher_latest_longitude END,
             dispatcher_location_updated_at = CASE WHEN $1 IN ('delivered', 'cancelled', 'failed') THEN NULL ELSE dispatcher_location_updated_at END,
             dispatcher_heading = CASE WHEN $1 IN ('delivered', 'cancelled', 'failed') THEN NULL ELSE dispatcher_heading END,
             dispatcher_speed = CASE WHEN $1 IN ('delivered', 'cancelled', 'failed') THEN NULL ELSE dispatcher_speed END,
             updated_at = NOW()
         WHERE order_id = $2
           AND dispatcher_id = $3
           AND status = $4
         RETURNING id, order_id, customer_id, vendor_id, status, updated_at`,
        [nextStatus, orderId, dispatcherId, current.status, issueNote],
      );
      const job = jobResult.rows[0];
      if (!job) {
        await client.query("ROLLBACK");
        return { errorStatus: 409, errorMessage: "Delivery status changed before this update could be saved" };
      }

      const nextOrderStatus = deliveryStatusToOrderStatus(nextStatus);
      const orderResult = await client.query<{ id: string; user_id: string; status: string; updated_at: string }>(
        `UPDATE orders
         SET status = $1,
             picked_up_at = CASE WHEN $1 = 'picked_up' THEN NOW() ELSE picked_up_at END,
             delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END,
             updated_at = NOW()
         WHERE id = $2 AND dispatcher_id = $3
         RETURNING id, user_id, status, updated_at`,
        [nextOrderStatus, orderId, dispatcherId],
      );

      await client.query("COMMIT");
      return { job, order: orderResult.rows[0] };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });

  if ("errorStatus" in result) {
    return res.status(result.errorStatus ?? 500).json({ ok: false, message: result.errorMessage });
  }

  const { job, order } = result;
  clearDeliveryRouteCache(job.id);

  safeNotify(log, async () => {
    const notifications = [
      createNotification({
        recipientUserId: order.user_id,
        recipientRole: "user",
        type: "order_status_changed",
        title: "Delivery status updated",
        message: `Your delivery is now ${job.status.replace(/_/g, " ")}.`,
        relatedOrderId: order.id,
        relatedJobId: job.id,
      }),
    ];

    if (job.status === "heading_to_pickup" && job.vendor_id) {
      notifications.push(
        createNotification({
          recipientUserId: job.vendor_id,
          recipientRole: "vendor",
          type: "dispatcher_heading_to_pickup",
          title: "Dispatcher on the way",
          message: "A dispatcher is heading to your pickup location for this order.",
          relatedOrderId: order.id,
          relatedJobId: job.id,
        }),
      );
    }

    await Promise.all(notifications);
  });

  return res.json({
    ok: true,
    deliveryJob: {
      id: job.id,
      orderId: job.order_id,
      status: job.status,
      updatedAt: job.updated_at,
    },
    order: { id: order.id, userId: order.user_id, status: order.status, updatedAt: order.updated_at },
  });
});

router.post("/:orderId/tracking/location", requireAuthenticated, async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const user = req.user;
  if (!user || user.role !== "dispatcher") {
    return res.status(403).json({ ok: false, message: "Only dispatchers can publish delivery location" });
  }

  const latitude = readOptionalNumber(req.body?.latitude);
  const longitude = readOptionalNumber(req.body?.longitude);
  const heading = readOptionalNumber(req.body?.heading);
  const speed = readOptionalNumber(req.body?.speed);

  if (latitude === null || longitude === null || !isFiniteLatitude(latitude) || !isFiniteLongitude(longitude)) {
    return res.status(400).json({ ok: false, message: "Valid latitude and longitude are required" });
  }

  await ensureDeliveryJobTable({ query } as unknown as DbClient);
  const { rows } = await query<{
    id: string;
    order_id: string;
    dispatcher_id: string | null;
    status: string;
    dispatcher_location_updated_at: string | null;
  }>(
    `UPDATE delivery_jobs
     SET dispatcher_latest_latitude = $1,
         dispatcher_latest_longitude = $2,
         dispatcher_heading = $3,
         dispatcher_speed = $4,
         dispatcher_location_updated_at = NOW(),
         tracking_status = 'live',
         updated_at = NOW()
     WHERE order_id = $5
       AND dispatcher_id = $6
       AND status = ANY($7::text[])
     RETURNING id, order_id, dispatcher_id, status, dispatcher_location_updated_at`,
    [
      latitude,
      longitude,
      heading,
      speed,
      orderId,
      user.id,
      DISPATCHER_ACTIVE_STATUSES,
    ],
  );

  const job = rows[0];
  if (!job) {
    return res.status(403).json({
      ok: false,
      message: "Location updates are only allowed for your active assigned delivery",
    });
  }

  return res.json({
    ok: true,
    deliveryJobId: job.id,
    orderId: job.order_id,
    status: job.status,
    locationUpdatedAt: job.dispatcher_location_updated_at,
  });
});

router.get("/:orderId/tracking/route", requireAuthenticated, async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const user = req.user;
  if (!user) {
    return res.status(401).json({ ok: false, message: "Authentication required" });
  }

  await ensureDeliveryJobTable({ query } as unknown as DbClient);
  const { rows } = await query<{
    user_id: string;
    delivery_job_id: string | null;
    delivery_status: string | null;
    dispatcher_id: string | null;
    vendor_id: string | null;
    pickup_latitude: number | null;
    pickup_longitude: number | null;
    dropoff_latitude: number | null;
    dropoff_longitude: number | null;
    dispatcher_latest_latitude: number | null;
    dispatcher_latest_longitude: number | null;
  }>(
    `SELECT
       o.user_id,
       dj.id AS delivery_job_id,
       dj.status AS delivery_status,
       dj.dispatcher_id,
       dj.vendor_id,
       dj.pickup_latitude,
       dj.pickup_longitude,
       dj.dropoff_latitude,
       dj.dropoff_longitude,
       dj.dispatcher_latest_latitude,
       dj.dispatcher_latest_longitude
     FROM orders o
     LEFT JOIN delivery_jobs dj ON dj.order_id = o.id
     WHERE o.id = $1
     LIMIT 1`,
    [orderId],
  );
  const order = rows[0];
  if (!order) {
    return res.status(404).json({ ok: false, message: "Order not found" });
  }
  if (!canViewTracking(user, order)) {
    return res.status(403).json({ ok: false, message: "Not authorized to view this delivery route" });
  }
  if (!order.delivery_job_id || !order.dispatcher_id || !order.delivery_status) {
    return res.json({ ok: true, route: null, reason: "dispatcher_not_assigned" });
  }
  if (["delivered", "cancelled", "failed"].includes(order.delivery_status)) {
    clearDeliveryRouteCache(order.delivery_job_id);
    return res.json({ ok: true, route: null, reason: "tracking_complete" });
  }

  const toPickupStatuses = ["accepted", "heading_to_pickup", "arrived_at_pickup"];
  const toDropoffStatuses = ["picked_up", "heading_to_dropoff", "arrived_at_dropoff"];
  const phase = toPickupStatuses.includes(order.delivery_status)
    ? "to_pickup"
    : toDropoffStatuses.includes(order.delivery_status)
      ? "to_dropoff"
      : null;
  if (!phase) {
    return res.json({ ok: true, route: null, reason: "route_not_active" });
  }

  const originLatitude = order.dispatcher_latest_latitude;
  const originLongitude = order.dispatcher_latest_longitude;
  const destinationLatitude =
    phase === "to_pickup" ? order.pickup_latitude : order.dropoff_latitude;
  const destinationLongitude =
    phase === "to_pickup" ? order.pickup_longitude : order.dropoff_longitude;
  if (
    originLatitude === null ||
    originLongitude === null ||
    destinationLatitude === null ||
    destinationLongitude === null ||
    !isFiniteLatitude(originLatitude) ||
    !isFiniteLongitude(originLongitude) ||
    !isFiniteLatitude(destinationLatitude) ||
    !isFiniteLongitude(destinationLongitude)
  ) {
    return res.json({ ok: true, route: null, reason: "location_not_available" });
  }

  try {
    const route = await getCachedDeliveryRoute({
      deliveryJobId: order.delivery_job_id,
      phase,
      origin: { latitude: originLatitude, longitude: originLongitude },
      destination: { latitude: destinationLatitude, longitude: destinationLongitude },
    });
    return res.json({
      ok: true,
      route: {
        ...route,
        etaMinutes: Math.max(1, Math.ceil(route.durationSeconds / 60)),
      },
    });
  } catch (error) {
    if (error instanceof GoogleMapsServiceError) {
      return res.status(error.statusCode).json({
        ok: false,
        code: error.code,
        message: error.message,
      });
    }
    req.log.error({ err: error, orderId }, "Delivery route calculation failed");
    return res.status(500).json({ ok: false, message: "Could not calculate the delivery route" });
  }
});

router.get("/:orderId/tracking", requireAuthenticated, async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const user = req.user || (await authenticateRequest(req));
  if (!user) {
    return res.status(401).json({ ok: false, message: "Authentication required" });
  }

  await ensureDeliveryJobTable({ query } as unknown as DbClient);
  const { rows } = await query<{
    id: string;
    user_id: string;
    order_status: string;
    created_at: string;
    updated_at: string;
    items: unknown;
    delivery_job_id: string | null;
    delivery_status: string | null;
    pickup_details: string | null;
    dropoff_details: string | null;
    pickup_formatted_address: string | null;
    pickup_latitude: number | null;
    pickup_longitude: number | null;
    pickup_place_id: string | null;
    pickup_instructions: string | null;
    pickup_landmark: string | null;
    pickup_contact_name: string | null;
    pickup_contact_phone: string | null;
    dropoff_formatted_address: string | null;
    dropoff_latitude: number | null;
    dropoff_longitude: number | null;
    dropoff_place_id: string | null;
    dropoff_instructions: string | null;
    dropoff_landmark: string | null;
    dropoff_contact_name: string | null;
    dropoff_contact_phone: string | null;
    dispatcher_latest_latitude: number | null;
    dispatcher_latest_longitude: number | null;
    dispatcher_location_updated_at: string | null;
    dispatcher_heading: number | null;
    dispatcher_speed: number | null;
    tracking_status: string | null;
    dispatcher_id: string | null;
    vendor_id: string | null;
    issue_note: string | null;
    failure_reason: string | null;
    buyer_name: string | null;
    vendor_name: string | null;
    dispatcher_name: string | null;
    dispatcher_phone: string | null;
  }>(
    `SELECT
       o.id,
       o.user_id,
       o.status AS order_status,
       o.created_at,
       o.updated_at,
       o.items,
       dj.id AS delivery_job_id,
       dj.status AS delivery_status,
       dj.pickup_details,
       dj.dropoff_details,
       dj.pickup_formatted_address,
       dj.pickup_latitude,
       dj.pickup_longitude,
       dj.pickup_place_id,
       dj.pickup_instructions,
       dj.pickup_landmark,
       dj.pickup_contact_name,
       dj.pickup_contact_phone,
       dj.dropoff_formatted_address,
       dj.dropoff_latitude,
       dj.dropoff_longitude,
       dj.dropoff_place_id,
       dj.dropoff_instructions,
       dj.dropoff_landmark,
       dj.dropoff_contact_name,
       dj.dropoff_contact_phone,
       dj.dispatcher_latest_latitude,
       dj.dispatcher_latest_longitude,
       dj.dispatcher_location_updated_at,
       dj.dispatcher_heading,
       dj.dispatcher_speed,
       dj.tracking_status,
       dj.dispatcher_id,
       dj.vendor_id,
       dj.issue_note,
       dj.failure_reason,
       COALESCE(NULLIF(c.first_name, ''), split_part(c.email, '@', 1)) AS buyer_name,
       COALESCE(NULLIF(v.first_name, ''), split_part(v.email, '@', 1)) AS vendor_name,
       TRIM(CONCAT(COALESCE(d.first_name, ''), ' ', COALESCE(d.last_name, ''))) AS dispatcher_name,
       d.phone AS dispatcher_phone
     FROM orders o
     LEFT JOIN delivery_jobs dj ON dj.order_id = o.id
     LEFT JOIN users c ON c.id = o.user_id
     LEFT JOIN users v ON v.id = dj.vendor_id
     LEFT JOIN users d ON d.id = dj.dispatcher_id
     WHERE o.id = $1`,
    [orderId],
  );

  const order = rows[0];
  if (!order) {
    return res.status(404).json({ ok: false, message: "Order not found" });
  }
  if (!canViewTracking(user, order)) {
    return res.status(403).json({ ok: false, message: "Not authorized to view this delivery tracking" });
  }

  const status = order.delivery_status || order.order_status;
  const tracking = buildTrackingSteps(status);
  const etaMinutes = null;
  const { itemCount, orderSummary } = summarizeItems(order.items);
  const dispatcherLocation = mapStructuredLocation({
    latitude: order.dispatcher_latest_latitude,
    longitude: order.dispatcher_latest_longitude,
  });
  const trackingComplete = ["delivered", "cancelled", "failed"].includes(status);
  const hasDispatcherCoordinates =
    !trackingComplete &&
    dispatcherLocation.latitude !== null && dispatcherLocation.longitude !== null;

  return res.json({
    ok: true,
    orderId: order.id,
    userId: order.user_id,
    deliveryJobId: order.delivery_job_id,
    dispatcherId: order.dispatcher_id,
    vendorId: order.vendor_id,
    status,
    orderStatus: order.order_status,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    pickupDetails: order.pickup_details || order.vendor_name || "Vendor pickup",
    dropoffDetails: order.dropoff_details || "Customer dropoff",
    pickupLocation: mapStructuredLocation({
      details: order.pickup_details || order.vendor_name || "Vendor pickup",
      formattedAddress: order.pickup_formatted_address,
      latitude: order.pickup_latitude,
      longitude: order.pickup_longitude,
      placeId: order.pickup_place_id,
      instructions: order.pickup_instructions,
      landmark: order.pickup_landmark,
      contactName: order.pickup_contact_name || order.vendor_name,
      contactPhone: order.pickup_contact_phone,
    }),
    dropoffLocation: mapStructuredLocation({
      details: order.dropoff_details || "Customer dropoff",
      formattedAddress: order.dropoff_formatted_address,
      latitude: order.dropoff_latitude,
      longitude: order.dropoff_longitude,
      placeId: order.dropoff_place_id,
      instructions: order.dropoff_instructions,
      landmark: order.dropoff_landmark,
      contactName: order.dropoff_contact_name || order.buyer_name,
      contactPhone: order.dropoff_contact_phone,
    }),
    dispatcherLocation: hasDispatcherCoordinates
      ? {
          latitude: dispatcherLocation.latitude,
          longitude: dispatcherLocation.longitude,
          heading: order.dispatcher_heading,
          speed: order.dispatcher_speed,
          updatedAt: order.dispatcher_location_updated_at,
          trackingStatus: order.tracking_status || "live",
        }
      : null,
    dispatcher:
      order.dispatcher_id && !trackingComplete
        ? {
            id: order.dispatcher_id,
            name: order.dispatcher_name?.trim() || "Assigned dispatcher",
            phone: order.dispatcher_phone || null,
          }
        : null,
    buyerName: order.buyer_name,
    vendorName: order.vendor_name,
    orderSummary,
    itemCount,
    issueNote: order.issue_note,
    failureReason: order.failure_reason,
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
