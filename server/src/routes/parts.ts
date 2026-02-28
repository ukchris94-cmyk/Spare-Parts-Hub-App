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
