import { Router, Request, Response } from "express";
import { query } from "../db";

const router = Router();

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
      const userResult = await query<UserRow>(
        "SELECT id, email, role FROM users WHERE role = 'user' ORDER BY created_at DESC LIMIT 1"
      );
      user = userResult.rows[0];
    }

    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    const vehiclesResult = await query<VehicleRow>(
      `SELECT id, year, make, model, trim, engine, is_primary, created_at
       FROM vehicles
       WHERE user_id = $1
       ORDER BY is_primary DESC, created_at DESC`,
      [user.id]
    );

    const partsResult = await query<PartRow>(
      `SELECT id, name, description
       FROM parts
       ORDER BY created_at DESC
       LIMIT 8`
    );

    const vehicles = vehiclesResult.rows.map((vehicle) => ({
      id: vehicle.id,
      title: makeVehicleTitle(vehicle),
      subtitle: makeVehicleSubtitle(vehicle),
      isPrimary: vehicle.is_primary,
    }));

    const trendingParts = partsResult.rows.map((part) => ({
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
    log.error({ err, userId }, "Home data query failed");
    return res
      .status(500)
      .json({ ok: false, message: "Could not load home data" });
  }
});

export default router;
