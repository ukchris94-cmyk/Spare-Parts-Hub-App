import { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { query } from "../db";
import { requireAuthenticated } from "../middleware/auth";
import {
  autocompletePlaces,
  GoogleMapsServiceError,
  PlaceAddressComponent,
  resolvePlace,
  reverseGeocode,
} from "../services/googleMaps";

const router = Router();

type DbClient = {
  query: <T = any>(
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

type VendorPickupRow = {
  vendor_id: string;
  formatted_address: string;
  latitude: number;
  longitude: number;
  place_id: string | null;
  address_components: PlaceAddressComponent[] | null;
  instructions: string | null;
  landmark: string | null;
  created_at: string;
  updated_at: string;
};

export async function ensureVendorPickupLocationTable(client: DbClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS vendor_pickup_locations (
      vendor_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      formatted_address TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      place_id TEXT,
      address_components JSONB,
      instructions TEXT,
      landmark TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function limitPerMinute(max: number) {
  return rateLimit({
    windowMs: 60_000,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || "authenticated-user",
    message: { ok: false, message: "Too many location requests. Please try again shortly." },
  });
}

const searchLimiter = limitPerMinute(30);
const detailLimiter = limitPerMinute(10);

function trimmed(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validCoordinate(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function sanitizeAddressComponents(value: unknown): PlaceAddressComponent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const component = item as Record<string, unknown>;
    return [
      {
        longText: trimmed(component.longText, 160) || undefined,
        shortText: trimmed(component.shortText, 80) || undefined,
        types: Array.isArray(component.types)
          ? component.types
              .filter((type): type is string => typeof type === "string")
              .slice(0, 12)
              .map((type) => type.slice(0, 80))
          : undefined,
        languageCode: trimmed(component.languageCode, 16) || undefined,
      },
    ];
  });
}

function mapVendorPickup(row: VendorPickupRow) {
  return {
    vendorId: row.vendor_id,
    formattedAddress: row.formatted_address,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    placeId: row.place_id,
    addressComponents: Array.isArray(row.address_components) ? row.address_components : [],
    instructions: row.instructions,
    landmark: row.landmark,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function handleGoogleMapsError(req: Request, res: Response, error: unknown): Response {
  if (error instanceof GoogleMapsServiceError) {
    return res.status(error.statusCode).json({
      ok: false,
      code: error.code,
      message: error.message,
    });
  }
  req.log.error({ err: error }, "Location service request failed");
  return res.status(500).json({ ok: false, message: "Location service request failed" });
}

router.post(
  "/places/autocomplete",
  requireAuthenticated,
  searchLimiter,
  async (req: Request, res: Response) => {
    const input = trimmed(req.body?.input, 160);
    const sessionToken = trimmed(req.body?.sessionToken, 100);
    if (input.length < 3) {
      return res.status(400).json({ ok: false, message: "Enter at least 3 characters" });
    }
    try {
      const result = await autocompletePlaces(input, sessionToken || undefined);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return handleGoogleMapsError(req, res, error);
    }
  }
);

router.post(
  "/places/resolve",
  requireAuthenticated,
  detailLimiter,
  async (req: Request, res: Response) => {
    const placeId = trimmed(req.body?.placeId, 220);
    const sessionToken = trimmed(req.body?.sessionToken, 100);
    if (!placeId) {
      return res.status(400).json({ ok: false, message: "placeId is required" });
    }
    try {
      const location = await resolvePlace(placeId, sessionToken || undefined);
      return res.json({ ok: true, location });
    } catch (error) {
      return handleGoogleMapsError(req, res, error);
    }
  }
);

router.post(
  "/reverse-geocode",
  requireAuthenticated,
  detailLimiter,
  async (req: Request, res: Response) => {
    const latitude = req.body?.latitude;
    const longitude = req.body?.longitude;
    if (!validCoordinate(latitude, -90, 90) || !validCoordinate(longitude, -180, 180)) {
      return res.status(400).json({ ok: false, message: "Valid coordinates are required" });
    }
    try {
      const location = await reverseGeocode({ latitude, longitude });
      return res.json({ ok: true, location });
    } catch (error) {
      return handleGoogleMapsError(req, res, error);
    }
  }
);

router.get("/vendor-pickup", requireAuthenticated, async (req: Request, res: Response) => {
  if (req.user?.role !== "vendor") {
    return res.status(403).json({ ok: false, message: "Only vendors can manage pickup locations" });
  }
  try {
    await ensureVendorPickupLocationTable({ query } as unknown as DbClient);
    const result = await query<VendorPickupRow>(
      "SELECT * FROM vendor_pickup_locations WHERE vendor_id = $1 LIMIT 1",
      [req.user.id]
    );
    return res.json({
      ok: true,
      pickupLocation: result.rows[0] ? mapVendorPickup(result.rows[0]) : null,
    });
  } catch (error) {
    req.log.error({ err: error }, "Could not load vendor pickup location");
    return res.status(500).json({ ok: false, message: "Could not load pickup location" });
  }
});

router.put(
  "/vendor-pickup",
  requireAuthenticated,
  detailLimiter,
  async (req: Request, res: Response) => {
    if (req.user?.role !== "vendor") {
      return res.status(403).json({ ok: false, message: "Only vendors can manage pickup locations" });
    }
    const formattedAddress = trimmed(req.body?.formattedAddress, 300);
    const latitude = req.body?.latitude;
    const longitude = req.body?.longitude;
    const placeId = trimmed(req.body?.placeId, 220) || null;
    const instructions = trimmed(req.body?.instructions, 500) || null;
    const landmark = trimmed(req.body?.landmark, 160) || null;
    const addressComponents = sanitizeAddressComponents(req.body?.addressComponents);

    if (!formattedAddress) {
      return res.status(400).json({ ok: false, message: "Pickup address is required" });
    }
    if (!validCoordinate(latitude, -90, 90) || !validCoordinate(longitude, -180, 180)) {
      return res.status(400).json({ ok: false, message: "Valid pickup coordinates are required" });
    }

    try {
      await ensureVendorPickupLocationTable({ query } as unknown as DbClient);
      const result = await query<VendorPickupRow>(
        `INSERT INTO vendor_pickup_locations (
           vendor_id, formatted_address, latitude, longitude, place_id,
           address_components, instructions, landmark
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         ON CONFLICT (vendor_id) DO UPDATE SET
           formatted_address = EXCLUDED.formatted_address,
           latitude = EXCLUDED.latitude,
           longitude = EXCLUDED.longitude,
           place_id = EXCLUDED.place_id,
           address_components = EXCLUDED.address_components,
           instructions = EXCLUDED.instructions,
           landmark = EXCLUDED.landmark,
           updated_at = NOW()
         RETURNING *`,
        [
          req.user.id,
          formattedAddress,
          latitude,
          longitude,
          placeId,
          JSON.stringify(addressComponents),
          instructions,
          landmark,
        ]
      );
      return res.json({ ok: true, pickupLocation: mapVendorPickup(result.rows[0]) });
    } catch (error) {
      req.log.error({ err: error }, "Could not save vendor pickup location");
      return res.status(500).json({ ok: false, message: "Could not save pickup location" });
    }
  }
);

export default router;
