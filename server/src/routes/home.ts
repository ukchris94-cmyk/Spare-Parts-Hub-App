import { Router, Request, Response } from "express";
import { query, withClient } from "../db";

const router = Router();

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

type UserRow = {
  id: string;
  email: string;
  role: string;
};

type VehicleRow = {
  id: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  engine: string | null;
  is_primary: boolean;
  created_at: string;
};

type PartRow = {
  id: string;
  name: string;
  description: string | null;
};

function isDbColumnError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: string }).code === "42703"
  );
}

function makeVehicleTitle(vehicle: VehicleRow): string {
  const year = vehicle.year ? String(vehicle.year) : "";
  const make = vehicle.make ?? "";
  const model = vehicle.model ?? "";
  return `${year} ${make} ${model}`.trim() || "Unknown vehicle";
}

function makeVehicleSubtitle(vehicle: VehicleRow): string {
  if (vehicle.trim && vehicle.engine) return `${vehicle.trim} · ${vehicle.engine}`;
  if (vehicle.trim) return vehicle.trim;
  if (vehicle.engine) return vehicle.engine;
  return "Vehicle details unavailable";
}

function fallbackHomePayload() {
  return {
    userName: "Alex",
    subtitle: "Browse genuine parts, track your orders and manage your vehicles.",
    vehicles: [
      {
        id: "vehicle-fallback-1",
        title: "2022 Toyota Corolla",
        subtitle: "1.8L Hybrid",
        isPrimary: true,
      },
    ],
    trendingParts: [
      {
        id: "part-fallback-1",
        name: "Premium Synthetic Oil 0W-20",
        subtitle: "Top rated part",
        query: "Premium Synthetic Oil 0W-20",
      },
      {
        id: "part-fallback-2",
        name: "Ceramic Brake Pads (Front)",
        subtitle: "Top rated part",
        query: "Ceramic Brake Pads",
      },
    ],
    promo: {
      title: "Rainy Season Special",
      body: "Stay safe on flooded roads and slippery highways. Up to 25% off on brake pads, wipers, headlights & tires.",
      cta: "Shop now",
    },
    categories: [
      "Engine",
      "Brakes",
      "Lighting",
      "Batteries",
      "Tires",
      "Fluids",
      "Filters",
      "All",
    ],
  };
}

async function resolveUserId(requestedUserId?: string): Promise<string | null> {
  if (requestedUserId) {
    const userResult = await query<UserRow>(
      "SELECT id, email, role FROM users WHERE id = $1",
      [requestedUserId]
    );
    return userResult.rows[0]?.id ?? null;
  }

  try {
    const userResult = await query<UserRow>(
      "SELECT id, email, role FROM users ORDER BY created_at DESC LIMIT 1"
    );
    return userResult.rows[0]?.id ?? null;
  } catch (err) {
    if (!isDbColumnError(err)) throw err;
    const userResult = await query<UserRow>(
      "SELECT id, email, role FROM users ORDER BY id DESC LIMIT 1"
    );
    return userResult.rows[0]?.id ?? null;
  }
}

// Compatibility endpoint for mobile clients currently calling `/home/user`.
router.get("/user", async (req: Request, res: Response) => {
  const log = req.log;
  const userId = typeof req.query.userId === "string" ? req.query.userId : "";

  try {
    let user: UserRow | undefined;
    if (userId) {
      const userResult = await query<UserRow>(
        "SELECT id, email, role FROM users WHERE id = $1",
        [userId]
      );
      user = userResult.rows[0];
    } else {
      try {
        const userResult = await query<UserRow>(
          "SELECT id, email, role FROM users ORDER BY created_at DESC LIMIT 1"
        );
        user = userResult.rows[0];
      } catch (err) {
        if (!isDbColumnError(err)) throw err;
        log.warn({ err }, "Falling back to users ORDER BY id (created_at missing)");
        const userResult = await query<UserRow>(
          "SELECT id, email, role FROM users ORDER BY id DESC LIMIT 1"
        );
        user = userResult.rows[0];
      }
    }

    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    let vehiclesRows: VehicleRow[] = [];
    try {
      const vehiclesResult = await query<VehicleRow>(
        `SELECT id, year, make, model, trim, engine, is_primary, created_at
         FROM vehicles
         WHERE user_id = $1
         ORDER BY is_primary DESC, created_at DESC`,
        [user.id]
      );
      vehiclesRows = vehiclesResult.rows;
    } catch (err) {
      if (!isDbColumnError(err)) throw err;
      log.warn({ err, userId: user.id }, "Falling back to legacy vehicles query");
      const vehiclesResult = await query<VehicleRow>(
        `SELECT id, year, make, model, NULL::text AS trim, NULL::text AS engine, is_primary, NOW()::text AS created_at
         FROM vehicles
         WHERE user_id = $1
         ORDER BY is_primary DESC, id DESC`,
        [user.id]
      );
      vehiclesRows = vehiclesResult.rows;
    }

    let partsRows: PartRow[] = [];
    try {
      const partsResult = await query<PartRow>(
        `SELECT id, name, description
         FROM parts
         ORDER BY created_at DESC
         LIMIT 8`
      );
      partsRows = partsResult.rows;
    } catch (err) {
      if (!isDbColumnError(err)) throw err;
      log.warn({ err }, "Falling back to legacy parts query");
      const partsResult = await query<PartRow>(
        `SELECT id, name, description
         FROM parts
         ORDER BY id DESC
         LIMIT 8`
      );
      partsRows = partsResult.rows;
    }

    const vehicles = vehiclesRows.map((vehicle) => ({
      id: vehicle.id,
      title: makeVehicleTitle(vehicle),
      subtitle: makeVehicleSubtitle(vehicle),
      isPrimary: vehicle.is_primary,
    }));

    const trendingParts = partsRows.map((part) => ({
      id: part.id,
      name: part.name,
      subtitle: part.description ?? "Top rated part",
      query: part.name,
    }));

    return res.json({
      userName: user.email.split("@")[0],
      subtitle:
        "Browse genuine parts, track your orders and manage your vehicles.",
      vehicles,
      trendingParts,
      promo: {
        title: "Rainy Season Special",
        body: "Stay safe on flooded roads and slippery highways. Up to 25% off on brake pads, wipers, headlights & tires.",
        cta: "Shop now",
      },
      categories: [
        "Engine",
        "Brakes",
        "Lighting",
        "Batteries",
        "Tires",
        "Fluids",
        "Filters",
        "All",
      ],
    });
  } catch (err) {
    log.warn({ err, userId }, "Home data query failed, serving fallback payload");
    return res.json({
      ...fallbackHomePayload(),
      degraded: true,
    });
  }
});

// Compatibility endpoint for mobile AddVehicle screen.
router.post("/user/vehicles", async (req: Request, res: Response) => {
  const log = req.log;
  const body = req.body as {
    userId?: string;
    year?: number | string;
    make?: string;
    model?: string;
    trim?: string;
    vin?: string;
    isPrimary?: boolean;
  };

  const requestedUserId =
    typeof body.userId === "string" ? body.userId.trim() : "";
  const make = typeof body.make === "string" ? body.make.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const trim = typeof body.trim === "string" ? body.trim.trim() : "";
  const vin = typeof body.vin === "string" ? body.vin.trim() : "";
  const isPrimary = Boolean(body.isPrimary);

  let year: number | null = null;
  if (typeof body.year === "number" && Number.isFinite(body.year)) {
    year = body.year;
  } else if (typeof body.year === "string" && body.year.trim()) {
    const parsedYear = Number.parseInt(body.year.trim(), 10);
    year = Number.isFinite(parsedYear) ? parsedYear : null;
  }

  if (!make || !model) {
    return res
      .status(400)
      .json({ ok: false, message: "make and model are required" });
  }

  try {
    const userId = await resolveUserId(requestedUserId);
    if (!userId) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    const vehicleId = genId("veh");

    await withClient(async (client) => {
      await client.query("BEGIN");

      if (isPrimary) {
        await client.query(
          "UPDATE vehicles SET is_primary = FALSE WHERE user_id = $1",
          [userId]
        );
      }

      await client.query(
        `INSERT INTO vehicles
          (id, user_id, year, make, model, trim, vin, is_primary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [vehicleId, userId, year, make, model, trim || null, vin || null, isPrimary]
      );

      await client.query("COMMIT");
    });

    return res.status(201).json({
      ok: true,
      vehicle: {
        id: vehicleId,
        userId,
        year,
        make,
        model,
        trim: trim || null,
        vin: vin || null,
        isPrimary,
      },
    });
  } catch (err) {
    log.error({ err, requestedUserId }, "Create vehicle failed");
    return res
      .status(500)
      .json({ ok: false, message: "Could not save vehicle" });
  }
});

export default router;
