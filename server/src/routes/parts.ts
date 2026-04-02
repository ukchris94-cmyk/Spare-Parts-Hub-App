import { Router, Request, Response } from "express";
import { query } from "../db";

const router = Router();

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

router.get("/search", async (req: Request, res: Response) => {
  const { query: q, role, category } = req.query as {
    query?: string;
    role?: string;
    category?: string;
  };
  const log = req.log;
  const search = typeof q === "string" ? q.trim() : "";
  const roleFilter = typeof role === "string" ? role.trim() : null;
  const categoryFilter =
    typeof category === "string" ? category.trim().toLowerCase() : "";

  let sql = "SELECT id, name, description, role FROM parts WHERE 1=1";
  const params: string[] = [];
  let i = 1;
  if (search) {
    params.push(`%${search}%`);
    sql += ` AND (name ILIKE $${i} OR description ILIKE $${i})`;
    i++;
  }
  if (roleFilter) {
    params.push(roleFilter);
    sql += ` AND role = $${i}`;
    i++;
  }
  if (categoryFilter && categoryFilter !== "all") {
    params.push(`%${categoryFilter}%`);
    sql += ` AND (name ILIKE $${i} OR description ILIKE $${i})`;
    i++;
  }
  sql += " ORDER BY name LIMIT 50";

  const { rows } = await query<{ id: string; name: string; description: string | null; role: string | null }>(
    sql,
    params
  );
  log.debug({ query: search, role: roleFilter, count: rows.length }, "Parts search");
  return res.json({
    query: search,
    role: roleFilter ?? undefined,
    category: categoryFilter || undefined,
    results: rows,
  });
});

router.post("/", async (req: Request, res: Response) => {
  const log = req.log;
  const { name, description, role } = req.body as {
    name?: string;
    description?: string;
    role?: string;
  };

  const normalizedName = typeof name === "string" ? name.trim() : "";
  const normalizedDescription =
    typeof description === "string" ? description.trim() : "";
  const normalizedRole = typeof role === "string" ? role.trim().toLowerCase() : null;

  if (!normalizedName) {
    return res.status(400).json({ ok: false, message: "name is required" });
  }

  const id = genId("part");
  try {
    await query(
      "INSERT INTO parts (id, name, description, role) VALUES ($1, $2, $3, $4)",
      [id, normalizedName, normalizedDescription || null, normalizedRole],
    );
    log.info({ id, role: normalizedRole }, "Part created");
    return res.status(201).json({
      ok: true,
      id,
      name: normalizedName,
      description: normalizedDescription || null,
      role: normalizedRole,
    });
  } catch (err) {
    log.error({ err, name: normalizedName }, "Part create failed");
    throw err;
  }
});

router.post("/requests", async (req: Request, res: Response) => {
  const log = req.log;
  const { userId, vehicle, partDescription, urgency } = req.body as {
    userId?: string;
    vehicle?: string;
    partDescription?: string;
    urgency?: string;
  };

  if (!userId) {
    return res.status(400).json({ ok: false, message: "userId is required" });
  }

  const id = genId("req");
  try {
    await query(
      `INSERT INTO part_requests (id, user_id, vehicle, part_description, urgency, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, vehicle ?? null, partDescription ?? null, urgency ?? null, "open"]
    );
    log.info({ requestId: id, userId }, "Part request created");
    return res.status(201).json({
      id,
      userId,
      vehicle: vehicle ?? null,
      partDescription: partDescription ?? null,
      urgency: urgency ?? null,
      status: "open",
    });
  } catch (err) {
    log.error({ err, userId }, "Part request create failed");
    throw err;
  }
});

router.get("/requests/user/:userId", async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { rows } = await query<{
    id: string;
    user_id: string;
    vehicle: string | null;
    part_description: string | null;
    urgency: string | null;
    status: string;
    created_at: string;
  }>(
    `SELECT id, user_id, vehicle, part_description, urgency, status, created_at
     FROM part_requests
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  return res.json({
    ok: true,
    requests: rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      vehicle: row.vehicle,
      partDescription: row.part_description,
      urgency: row.urgency,
      status: row.status,
      createdAt: row.created_at,
    })),
  });
});

router.get("/requests/:requestId/offers", async (req: Request, res: Response) => {
  const { requestId } = req.params;

  const requestResult = await query<{
    id: string;
    vehicle: string | null;
    part_description: string | null;
    urgency: string | null;
  }>(
    `SELECT id, vehicle, part_description, urgency
     FROM part_requests
     WHERE id = $1
     LIMIT 1`,
    [requestId]
  );
  const requestRow = requestResult.rows[0];

  if (!requestRow) {
    return res.status(404).json({ ok: false, message: "Request not found" });
  }

  const partRowsResult = await query<{
    id: string;
    name: string;
    description: string | null;
  }>(
    `SELECT id, name, description
     FROM parts
     WHERE role = 'vendor'
     ORDER BY created_at DESC
     LIMIT 6`
  );

  const fallbackNames = [
    "QuickFix Spares",
    "AutoHub Central",
    "PrimeParts Depot",
    "RoadReady Parts",
    "Zenith Auto Supply",
    "Metro Spares",
  ];

  const offers = partRowsResult.rows.slice(0, 5).map((part, index) => {
    const base = 35000 + index * 7000;
    const urgencyBonus = requestRow.urgency === "urgent" ? 3000 : 0;
    return {
      id: `off_${requestId}_${index + 1}`,
      requestId,
      partId: part.id,
      vendor: fallbackNames[index] ?? `Vendor ${index + 1}`,
      itemName: part.name,
      notes: part.description ?? requestRow.part_description ?? "",
      eta: `${35 + index * 20} mins`,
      total: base + urgencyBonus,
      currency: "NGN",
    };
  });

  return res.json({
    ok: true,
    request: {
      id: requestRow.id,
      vehicle: requestRow.vehicle,
      partDescription: requestRow.part_description,
      urgency: requestRow.urgency,
    },
    offers,
  });
});

router.get("/:partId", async (req: Request, res: Response) => {
  const { partId } = req.params;
  const { rows } = await query<{
    id: string;
    name: string;
    description: string | null;
    role: string | null;
    created_at: string;
  }>(
    `SELECT id, name, description, role, created_at
     FROM parts
     WHERE id = $1`,
    [partId],
  );

  const part = rows[0];
  if (!part) {
    return res.status(404).json({ ok: false, message: "Part not found" });
  }

  return res.json({
    ok: true,
    part,
  });
});

export default router;
