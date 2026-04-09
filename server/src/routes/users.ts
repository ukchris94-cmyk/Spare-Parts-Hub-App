import { Router, Request, Response } from "express";
import { query, withClient } from "../db";

const router = Router();

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

type UserRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  role: string;
};

type VehicleRow = {
  id: string;
  user_id: string;
  year: number | null;
  mileage: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  engine: string | null;
  vin: string | null;
  is_primary: boolean;
  created_at: string;
};

type OrderRow = {
  id: string;
  user_id: string;
  status: string;
  created_at: string;
  items: unknown;
};

type PartRow = {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  role: string | null;
};

function buildKnownIssuePartNames(make?: string | null, model?: string | null): string[] {
  const key = `${make ?? ""} ${model ?? ""}`.toLowerCase();
  if (key.includes("toyota")) return ["Brake Pads", "Spark Plugs", "Oil Filter"];
  if (key.includes("honda")) return ["CVT Fluid", "Brake Rotors", "Cabin Filter"];
  if (key.includes("bmw")) return ["Ignition Coils", "Control Arm Bushings", "Oil Filter Housing Gasket"];
  if (key.includes("nissan")) return ["Transmission Fluid", "Brake Pads", "Engine Mount"];
  return ["Brake Pads", "Oil Filter", "Battery"];
}

// Home dashboard summary for the User role.
router.get("/:userId/home", async (req: Request, res: Response) => {
  const { userId } = req.params;
  const log = req.log;

  try {
    const { rows: userRows } = await query<UserRow>(
      "SELECT id, first_name, last_name, email, role FROM users WHERE id = $1",
      [userId]
    );
    const user = userRows[0];
    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    const { rows: vehicleRows } = await query<VehicleRow>(
      `SELECT id, user_id, year, mileage, make, model, trim, engine, vin, is_primary, created_at
       FROM vehicles
       WHERE user_id = $1
       ORDER BY is_primary DESC, created_at DESC`,
      [userId]
    );

    const primaryVehicle = vehicleRows.find((v) => v.is_primary) ?? vehicleRows[0] ?? null;

    const { rows: orderRows } = await query<OrderRow>(
      `SELECT id, user_id, status, created_at, items
       FROM orders
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 5`,
      [userId]
    );

    const pendingCount = orderRows.filter(
      (o) => o.status !== "delivered" && o.status !== "cancelled"
    ).length;

    const { rows: partsRows } = await query<PartRow>(
      `SELECT id, name, description, image_url, role
       FROM parts
       ORDER BY created_at DESC
       LIMIT 8`
    );
    const knownIssuePartNames = buildKnownIssuePartNames(
      primaryVehicle?.make,
      primaryVehicle?.model
    );
    const hotNewParts = partsRows.slice(0, 4);

    log.debug(
      {
        userId,
        vehicles: vehicleRows.length,
        orders: orderRows.length,
        trendingParts: partsRows.length,
      },
      "User home summary"
    );

    return res.json({
      ok: true,
      user: {
        id: user.id,
        firstName:
          typeof user.first_name === "string" && user.first_name.trim()
            ? user.first_name.trim()
            : "",
        lastName:
          typeof user.last_name === "string" && user.last_name.trim()
            ? user.last_name.trim()
            : "",
        email: user.email,
        role: user.role,
      },
      garage: {
        primaryVehicle,
        vehicles: vehicleRows,
        count: vehicleRows.length,
      },
      orders: {
        recent: orderRows.map((o) => ({
          id: o.id,
          status: o.status,
          createdAt: o.created_at,
          items: o.items ?? [],
        })),
        pendingCount,
      },
      recommendations: {
        trendingParts: partsRows.map((part) => ({
          ...part,
          imageUrl: part.image_url,
        })),
        quickService: {
          knownIssueParts: knownIssuePartNames.map((name) => ({
            name,
            query: name,
          })),
          hotNewParts: hotNewParts.map((part) => ({
            ...part,
            imageUrl: part.image_url,
          })),
        },
      },
    });
  } catch (err) {
    log.error({ err, userId }, "Failed to build user home summary");
    throw err;
  }
});

// List all vehicles for a user (used by both Home and Garage flows)
router.get("/:userId/vehicles", async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { rows } = await query<VehicleRow>(
    `SELECT id, user_id, year, mileage, make, model, trim, engine, vin, is_primary, created_at
     FROM vehicles
     WHERE user_id = $1
     ORDER BY is_primary DESC, created_at DESC`,
    [userId]
  );
  return res.json({
    ok: true,
    vehicles: rows,
  });
});

// Add a vehicle to the user's garage.
router.post("/:userId/vehicles", async (req: Request, res: Response) => {
  const { userId } = req.params;
  const log = req.log;
  const {
    year,
    mileage,
    make,
    model,
    trim,
    engine,
    vin,
    isPrimary,
  } = req.body as {
    year?: number;
    mileage?: number;
    make?: string;
    model?: string;
    trim?: string;
    engine?: string;
    vin?: string;
    isPrimary?: boolean;
  };

  if (mileage === undefined || mileage === null || !Number.isFinite(mileage) || mileage < 0) {
    return res.status(400).json({
      ok: false,
      message: "mileage is required and must be a valid number",
    });
  }

  if (!make || !model) {
    return res
      .status(400)
      .json({ ok: false, message: "make and model are required" });
  }

  const id = genId("veh");

  try {
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
          (id, user_id, year, mileage, make, model, trim, engine, vin, is_primary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, FALSE))`,
        [
          id,
          userId,
          year ?? null,
          mileage,
          make,
          model,
          trim ?? null,
          engine ?? null,
          vin ?? null,
          isPrimary ?? false,
        ]
      );

      await client.query("COMMIT");
    });

    log.info({ userId, vehicleId: id }, "Vehicle added to garage");
    return res.status(201).json({
      ok: true,
      vehicle: {
        id,
        userId,
        year: year ?? null,
        mileage,
        make,
        model,
        trim: trim ?? null,
        engine: engine ?? null,
        vin: vin ?? null,
        isPrimary: isPrimary ?? false,
      },
    });
  } catch (err) {
    log.error({ err, userId }, "Failed to add vehicle");
    throw err;
  }
});

// Update basic vehicle info or primary flag.
router.patch(
  "/:userId/vehicles/:vehicleId",
  async (req: Request, res: Response) => {
    const { userId, vehicleId } = req.params;
    const log = req.log;
    const {
      year,
      mileage,
      make,
      model,
      trim,
      engine,
      vin,
      isPrimary,
    } = req.body as {
      year?: number;
      mileage?: number;
      make?: string;
      model?: string;
      trim?: string;
      engine?: string;
      vin?: string;
      isPrimary?: boolean;
    };

    const fields: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (year !== undefined) {
      fields.push(`year = $${i++}`);
      params.push(year);
    }
    if (make !== undefined) {
      fields.push(`make = $${i++}`);
      params.push(make);
    }
    if (mileage !== undefined) {
      fields.push(`mileage = $${i++}`);
      params.push(mileage);
    }
    if (model !== undefined) {
      fields.push(`model = $${i++}`);
      params.push(model);
    }
    if (trim !== undefined) {
      fields.push(`trim = $${i++}`);
      params.push(trim);
    }
    if (engine !== undefined) {
      fields.push(`engine = $${i++}`);
      params.push(engine);
    }
    if (vin !== undefined) {
      fields.push(`vin = $${i++}`);
      params.push(vin);
    }

    if (!fields.length && isPrimary === undefined) {
      return res.status(400).json({
        ok: false,
        message: "No fields to update",
      });
    }

    try {
      await withClient(async (client) => {
        await client.query("BEGIN");

        if (isPrimary === true) {
          await client.query(
            "UPDATE vehicles SET is_primary = FALSE WHERE user_id = $1",
            [userId]
          );
        }

        if (fields.length) {
          params.push(userId, vehicleId);
          await client.query(
            `UPDATE vehicles
             SET ${fields.join(", ")}
             WHERE user_id = $${i++} AND id = $${i}`,
            params
          );
        }

        if (isPrimary !== undefined) {
          await client.query(
            `UPDATE vehicles
             SET is_primary = $1
             WHERE user_id = $2 AND id = $3`,
            [isPrimary, userId, vehicleId]
          );
        }

        await client.query("COMMIT");
      });

      log.info({ userId, vehicleId }, "Vehicle updated");
      return res.json({ ok: true });
    } catch (err) {
      log.error({ err, userId, vehicleId }, "Failed to update vehicle");
      throw err;
    }
  }
);

// Delete a vehicle from the garage.
router.delete(
  "/:userId/vehicles/:vehicleId",
  async (req: Request, res: Response) => {
    const { userId, vehicleId } = req.params;
    const log = req.log;

    try {
      const { rowCount } = await query(
        "DELETE FROM vehicles WHERE user_id = $1 AND id = $2",
        [userId, vehicleId]
      );

      if (!rowCount) {
        return res
          .status(404)
          .json({ ok: false, message: "Vehicle not found" });
      }

      log.info({ userId, vehicleId }, "Vehicle deleted");
      return res.json({ ok: true });
    } catch (err) {
      log.error({ err, userId, vehicleId }, "Failed to delete vehicle");
      throw err;
    }
  }
);

export default router;
