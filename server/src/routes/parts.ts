import { Router, Request, Response } from "express";
import { query } from "../db";

const router = Router();

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isDbColumnError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: string }).code === "42703"
  );
}

function toNullableInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
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

  let sql =
    "SELECT id, name, description, image_url, price_ngn, stock_qty, role FROM parts WHERE 1=1";
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

  let rows: Array<{
    id: string;
    name: string;
    description: string | null;
    image_url: string | null;
    price_ngn: number | null;
    stock_qty: number | null;
    role: string | null;
  }> = [];
  try {
    const result = await query<{
      id: string;
      name: string;
      description: string | null;
      image_url: string | null;
      price_ngn: number | null;
      stock_qty: number | null;
      role: string | null;
    }>(sql, params);
    rows = result.rows;
  } catch (err) {
    if (!isDbColumnError(err)) throw err;
    const legacySql = sql
      .replace("price_ngn, stock_qty, ", "")
      .replace("SELECT id, name, description, image_url, role", "SELECT id, name, description, image_url, role");
    const result = await query<{
      id: string;
      name: string;
      description: string | null;
      image_url: string | null;
      role: string | null;
    }>(legacySql, params);
    rows = result.rows.map((row) => ({
      ...row,
      price_ngn: null,
      stock_qty: null,
    }));
  }
  log.debug({ query: search, role: roleFilter, count: rows.length }, "Parts search");
  return res.json({
    query: search,
    role: roleFilter ?? undefined,
    category: categoryFilter || undefined,
    results: rows.map((row) => ({
      ...row,
      priceNgn: row.price_ngn,
      stockQty: row.stock_qty,
    })),
  });
});

router.post("/", async (req: Request, res: Response) => {
  const log = req.log;
  const { name, description, imageUrl, role, priceNgn, stockQty } = req.body as {
    name?: string;
    description?: string;
    imageUrl?: string;
    role?: string;
    priceNgn?: number | string;
    stockQty?: number | string;
  };

  const normalizedName = typeof name === "string" ? name.trim() : "";
  const normalizedDescription =
    typeof description === "string" ? description.trim() : "";
  const normalizedImageUrl =
    typeof imageUrl === "string" && imageUrl.trim() ? imageUrl.trim() : null;
  const normalizedRole = typeof role === "string" ? role.trim().toLowerCase() : null;
  const normalizedPriceNgn = toNullableInt(priceNgn);
  const normalizedStockQty = toNullableInt(stockQty);

  if (!normalizedName) {
    return res.status(400).json({ ok: false, message: "name is required" });
  }
  if (normalizedRole === "vendor" && (!normalizedPriceNgn || normalizedPriceNgn <= 0)) {
    return res
      .status(400)
      .json({ ok: false, message: "priceNgn is required for vendor parts" });
  }
  if (normalizedPriceNgn !== null && normalizedPriceNgn <= 0) {
    return res.status(400).json({ ok: false, message: "priceNgn must be a positive number" });
  }
  if (normalizedStockQty !== null && normalizedStockQty < 0) {
    return res.status(400).json({ ok: false, message: "stockQty cannot be negative" });
  }

  const id = genId("part");
  try {
    try {
      await query(
        "INSERT INTO parts (id, name, description, image_url, price_ngn, stock_qty, role) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          id,
          normalizedName,
          normalizedDescription || null,
          normalizedImageUrl,
          normalizedPriceNgn,
          normalizedStockQty,
          normalizedRole,
        ],
      );
    } catch (err) {
      if (!isDbColumnError(err)) throw err;
      await query(
        "INSERT INTO parts (id, name, description, image_url, role) VALUES ($1, $2, $3, $4, $5)",
        [id, normalizedName, normalizedDescription || null, normalizedImageUrl, normalizedRole],
      );
    }
    log.info({ id, role: normalizedRole }, "Part created");
    return res.status(201).json({
      ok: true,
      id,
      name: normalizedName,
      description: normalizedDescription || null,
      imageUrl: normalizedImageUrl,
      priceNgn: normalizedPriceNgn,
      stockQty: normalizedStockQty,
      role: normalizedRole,
    });
  } catch (err) {
    log.error({ err, name: normalizedName }, "Part create failed");
    throw err;
  }
});

router.patch("/:partId", async (req: Request, res: Response) => {
  const { partId } = req.params;
  const log = req.log;
  const { name, description, imageUrl, priceNgn, stockQty } = req.body as {
    name?: string;
    description?: string;
    imageUrl?: string;
    priceNgn?: number | string;
    stockQty?: number | string;
  };

  const normalizedName = typeof name === "string" ? name.trim() : undefined;
  const normalizedDescription =
    typeof description === "string" ? description.trim() : undefined;
  const normalizedImageUrl =
    typeof imageUrl === "string" ? imageUrl.trim() : undefined;
  const normalizedPriceNgn = toNullableInt(priceNgn);
  const normalizedStockQty = toNullableInt(stockQty);

  if (normalizedPriceNgn !== null && normalizedPriceNgn <= 0) {
    return res.status(400).json({ ok: false, message: "priceNgn must be a positive number" });
  }
  if (normalizedStockQty !== null && normalizedStockQty < 0) {
    return res.status(400).json({ ok: false, message: "stockQty cannot be negative" });
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  let index = 1;

  if (normalizedName !== undefined) {
    if (!normalizedName) {
      return res.status(400).json({ ok: false, message: "name cannot be empty" });
    }
    fields.push(`name = $${index++}`);
    values.push(normalizedName);
  }
  if (normalizedDescription !== undefined) {
    fields.push(`description = $${index++}`);
    values.push(normalizedDescription || null);
  }
  if (normalizedImageUrl !== undefined) {
    fields.push(`image_url = $${index++}`);
    values.push(normalizedImageUrl || null);
  }
  if (priceNgn !== undefined) {
    fields.push(`price_ngn = $${index++}`);
    values.push(normalizedPriceNgn);
  }
  if (stockQty !== undefined) {
    fields.push(`stock_qty = $${index++}`);
    values.push(normalizedStockQty);
  }

  if (!fields.length) {
    return res.status(400).json({ ok: false, message: "No fields to update" });
  }

  values.push(partId);

  try {
    let rows: Array<{
      id: string;
      name: string;
      description: string | null;
      image_url: string | null;
      price_ngn: number | null;
      stock_qty: number | null;
      role: string | null;
    }> = [];
    try {
      const result = await query<{
        id: string;
        name: string;
        description: string | null;
        image_url: string | null;
        price_ngn: number | null;
        stock_qty: number | null;
        role: string | null;
      }>(
        `UPDATE parts
         SET ${fields.join(", ")}
         WHERE id = $${index}
         RETURNING id, name, description, image_url, price_ngn, stock_qty, role`,
        values,
      );
      rows = result.rows;
    } catch (err) {
      if (!isDbColumnError(err)) throw err;
      const legacyFields = fields
        .filter((field) => !field.startsWith("price_ngn") && !field.startsWith("stock_qty"));
      const legacyValues = values.slice(0, values.length - 1);
      legacyValues.push(partId);
      if (!legacyFields.length) {
        return res.status(400).json({
          ok: false,
          message: "This server schema does not support price/stock updates yet.",
        });
      }
      const result = await query<{
        id: string;
        name: string;
        description: string | null;
        image_url: string | null;
        role: string | null;
      }>(
        `UPDATE parts
         SET ${legacyFields.join(", ")}
         WHERE id = $${legacyFields.length + 1}
         RETURNING id, name, description, image_url, role`,
        legacyValues,
      );
      rows = result.rows.map((row) => ({
        ...row,
        price_ngn: null,
        stock_qty: null,
      }));
    }

    const part = rows[0];
    if (!part) {
      return res.status(404).json({ ok: false, message: "Part not found" });
    }

    log.info({ partId }, "Part updated");
    return res.json({
      ok: true,
      part: {
        ...part,
        imageUrl: part.image_url,
        priceNgn: part.price_ngn,
        stockQty: part.stock_qty,
      },
    });
  } catch (err) {
    log.error({ err, partId }, "Part update failed");
    throw err;
  }
});

router.delete("/:partId", async (req: Request, res: Response) => {
  const { partId } = req.params;
  const result = await query("DELETE FROM parts WHERE id = $1", [partId]);
  if (!result.rowCount) {
    return res.status(404).json({ ok: false, message: "Part not found" });
  }
  return res.json({ ok: true });
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

  let offerRows: Array<{
    id: string;
    name: string;
    description: string | null;
    price_ngn: number | null;
    stock_qty: number | null;
  }> = [];
  try {
    const partRowsResult = await query<{
      id: string;
      name: string;
      description: string | null;
      price_ngn: number | null;
      stock_qty: number | null;
    }>(
      `SELECT id, name, description, price_ngn, stock_qty
       FROM parts
       WHERE role = 'vendor'
       ORDER BY created_at DESC
       LIMIT 6`
    );
    offerRows = partRowsResult.rows;
  } catch (err) {
    if (!isDbColumnError(err)) throw err;
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
    offerRows = partRowsResult.rows.map((row) => ({
      ...row,
      price_ngn: null,
      stock_qty: null,
    }));
  }

  const fallbackNames = [
    "QuickFix Spares",
    "AutoHub Central",
    "PrimeParts Depot",
    "RoadReady Parts",
    "Zenith Auto Supply",
    "Metro Spares",
  ];

  const offers = offerRows.slice(0, 5).map((part, index) => {
    const base = typeof part.price_ngn === "number" ? part.price_ngn : 35000 + index * 7000;
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
      stockQty: part.stock_qty,
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
  let rows: Array<{
    id: string;
    name: string;
    description: string | null;
    image_url: string | null;
    price_ngn: number | null;
    stock_qty: number | null;
    role: string | null;
    created_at: string;
  }> = [];
  try {
    const result = await query<{
      id: string;
      name: string;
      description: string | null;
      image_url: string | null;
      price_ngn: number | null;
      stock_qty: number | null;
      role: string | null;
      created_at: string;
    }>(
      `SELECT id, name, description, image_url, price_ngn, stock_qty, role, created_at
       FROM parts
       WHERE id = $1`,
      [partId],
    );
    rows = result.rows;
  } catch (err) {
    if (!isDbColumnError(err)) throw err;
    const result = await query<{
      id: string;
      name: string;
      description: string | null;
      image_url: string | null;
      role: string | null;
      created_at: string;
    }>(
      `SELECT id, name, description, image_url, role, created_at
       FROM parts
       WHERE id = $1`,
      [partId],
    );
    rows = result.rows.map((row) => ({
      ...row,
      price_ngn: null,
      stock_qty: null,
    }));
  }

  const part = rows[0];
  if (!part) {
    return res.status(404).json({ ok: false, message: "Part not found" });
  }

  return res.json({
    ok: true,
    part: {
      ...part,
      imageUrl: part.image_url,
      priceNgn: part.price_ngn,
      stockQty: part.stock_qty,
    },
  });
});

export default router;
