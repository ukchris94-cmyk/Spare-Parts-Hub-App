import { Router, Request, Response } from "express";
import { query } from "../db";

const router = Router();

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

router.get("/search", async (req: Request, res: Response) => {
  const { query: q, role } = req.query as { query?: string; role?: string };
  const log = req.log;
  const search = typeof q === "string" ? q.trim() : "";
  const roleFilter = typeof role === "string" ? role.trim() : null;

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
  sql += " ORDER BY name LIMIT 50";

  const { rows } = await query<{ id: string; name: string; description: string | null; role: string | null }>(
    sql,
    params
  );
  log.debug({ query: search, role: roleFilter, count: rows.length }, "Parts search");
  return res.json({
    query: search,
    role: roleFilter ?? undefined,
    results: rows,
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

export default router;
