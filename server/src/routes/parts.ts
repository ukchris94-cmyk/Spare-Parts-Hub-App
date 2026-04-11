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
  const { query: q, role, category, userId } = req.query as {
    query?: string;
    role?: string;
    category?: string;
    userId?: string;
  };
  const log = req.log;
  const search = typeof q === "string" ? q.trim() : "";
  const roleFilter = typeof role === "string" ? role.trim() : null;
  const userIdFilter = typeof userId === "string" ? userId.trim() : null;
  const categoryFilter =
    typeof category === "string" ? category.trim().toLowerCase() : "";

  let sql =
    `SELECT
      p.id,
      p.name,
      p.description,
      p.image_url,
      p.user_id,
      p.price_ngn,
      p.stock_qty,
      p.role,
      COALESCE(NULLIF(u.first_name, ''), split_part(u.email, '@', 1)) AS vendor_name
     FROM parts p
     LEFT JOIN users u ON u.id = p.user_id
     WHERE 1=1`;
  const params: string[] = [];
  let i = 1;
  if (search) {
    params.push(`%${search}%`);
    sql += ` AND (p.name ILIKE $${i} OR p.description ILIKE $${i})`;
    i++;
  }
  if (roleFilter) {
    params.push(roleFilter);
    sql += ` AND p.role = $${i}`;
    i++;
  }
  if (userIdFilter) {
    params.push(userIdFilter);
    sql += ` AND p.user_id = $${i}`;
    i++;
  }
  if (categoryFilter && categoryFilter !== "all") {
    params.push(`%${categoryFilter}%`);
    sql += ` AND (p.name ILIKE $${i} OR p.description ILIKE $${i})`;
    i++;
  }
  sql += " ORDER BY p.name LIMIT 50";

  let rows: Array<{
    id: string;
    name: string;
    description: string | null;
    image_url: string | null;
    user_id: string | null;
    price_ngn: number | null;
    stock_qty: number | null;
    role: string | null;
    vendor_name: string | null;
  }> = [];
  try {
    const result = await query<{
      id: string;
      name: string;
      description: string | null;
      image_url: string | null;
      user_id: string | null;
      price_ngn: number | null;
      stock_qty: number | null;
      role: string | null;
      vendor_name: string | null;
    }>(sql, params);
    rows = result.rows;
  } catch (err) {
    if (!isDbColumnError(err)) throw err;
    const legacySql = sql
      .replace("p.user_id,", "")
      .replace("COALESCE(NULLIF(u.first_name, ''), split_part(u.email, '@', 1)) AS vendor_name", "NULL::text AS vendor_name")
      .replace("p.price_ngn, p.stock_qty,", "")
      .replace("LEFT JOIN users u ON u.id = p.user_id", "")
      .replace(/ AND p\.user_id = \$\d+/, "")
      .replace(/p\./g, "");
    const result = await query<{
      id: string;
      name: string;
      description: string | null;
      image_url: string | null;
      role: string | null;
      vendor_name: string | null;
    }>(legacySql, params);
    rows = result.rows.map((row) => ({
      ...row,
      user_id: null,
      price_ngn: null,
      stock_qty: null,
    }));
  }
  log.debug(
    { query: search, role: roleFilter, userId: userIdFilter, count: rows.length },
    "Parts search",
  );
  return res.json({
    query: search,
    role: roleFilter ?? undefined,
    userId: userIdFilter ?? undefined,
    category: categoryFilter || undefined,
    results: rows.map((row) => ({
      ...row,
      userId: row.user_id,
      vendorName: row.vendor_name,
      priceNgn: row.price_ngn,
      stockQty: row.stock_qty,
    })),
  });
});

router.post("/", async (req: Request, res: Response) => {
  const log = req.log;
  const { userId, name, description, imageUrl, role, priceNgn, stockQty } = req.body as {
    userId?: string;
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
  const normalizedUserId = typeof userId === "string" && userId.trim() ? userId.trim() : null;
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
        "INSERT INTO parts (id, name, description, image_url, user_id, price_ngn, stock_qty, role) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [
          id,
          normalizedName,
          normalizedDescription || null,
          normalizedImageUrl,
          normalizedUserId,
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
      userId: normalizedUserId,
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

router.get("/requests/open", async (req: Request, res: Response) => {
  const vendorUserId =
    typeof req.query.userId === "string" ? req.query.userId.trim() : "";
  const limitRaw =
    typeof req.query.limit === "string"
      ? Number.parseInt(req.query.limit, 10)
      : 20;
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 20;

  const { rows } = await query<{
    id: string;
    user_id: string;
    vehicle: string | null;
    part_description: string | null;
    urgency: string | null;
    status: string;
    created_at: string;
    requester_name: string | null;
  }>(
    `SELECT
       pr.id,
       pr.user_id,
       pr.vehicle,
       pr.part_description,
       pr.urgency,
       pr.status,
       pr.created_at,
       COALESCE(NULLIF(u.first_name, ''), split_part(u.email, '@', 1)) AS requester_name
     FROM part_requests pr
     LEFT JOIN users u ON u.id = pr.user_id
     WHERE pr.status IN ('open', 'quoted')
     ORDER BY pr.created_at DESC
     LIMIT $1`,
    [limit],
  );

  let quotedRequestIds = new Set<string>();
  if (vendorUserId) {
    const quoteRows = await query<{ request_id: string }>(
      `SELECT request_id
       FROM part_request_quotes
       WHERE vendor_user_id = $1`,
      [vendorUserId],
    );
    quotedRequestIds = new Set(quoteRows.rows.map((row) => row.request_id));
  }

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
      requesterName: row.requester_name,
      hasQuoted: vendorUserId ? quotedRequestIds.has(row.id) : false,
    })),
  });
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
    quote_count: number;
  }>(
    `SELECT
       pr.id,
       pr.user_id,
       pr.vehicle,
       pr.part_description,
       pr.urgency,
       pr.status,
       pr.created_at,
       COUNT(q.id)::int AS quote_count
     FROM part_requests pr
     LEFT JOIN part_request_quotes q ON q.request_id = pr.id
     WHERE pr.user_id = $1
     GROUP BY pr.id
     ORDER BY pr.created_at DESC`,
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
      quoteCount: row.quote_count,
    })),
  });
});

router.post("/requests/:requestId/quotes", async (req: Request, res: Response) => {
  const { requestId } = req.params;
  const log = req.log;
  const {
    vendorUserId,
    partId,
    priceNgn,
    etaMinutes,
    note,
  } = req.body as {
    vendorUserId?: string;
    partId?: string;
    priceNgn?: number | string;
    etaMinutes?: number | string;
    note?: string;
  };

  const normalizedVendorUserId =
    typeof vendorUserId === "string" ? vendorUserId.trim() : "";
  const normalizedPartId = typeof partId === "string" && partId.trim() ? partId.trim() : null;
  const normalizedPriceNgn = toNullableInt(priceNgn);
  const normalizedEtaMinutes = toNullableInt(etaMinutes);
  const normalizedNote = typeof note === "string" ? note.trim() : "";

  if (!normalizedVendorUserId) {
    return res.status(400).json({ ok: false, message: "vendorUserId is required" });
  }
  if (!normalizedPriceNgn || normalizedPriceNgn <= 0) {
    return res.status(400).json({ ok: false, message: "priceNgn must be a positive number" });
  }
  if (normalizedEtaMinutes !== null && normalizedEtaMinutes <= 0) {
    return res.status(400).json({ ok: false, message: "etaMinutes must be a positive number" });
  }

  const requestRow = await query<{ id: string }>(
    `SELECT id FROM part_requests WHERE id = $1 LIMIT 1`,
    [requestId],
  );
  if (!requestRow.rows[0]) {
    return res.status(404).json({ ok: false, message: "Request not found" });
  }

  const quoteId = genId("qt");
  const result = await query<{
    id: string;
    request_id: string;
    vendor_user_id: string;
    part_id: string | null;
    price_ngn: number;
    eta_minutes: number | null;
    note: string | null;
    status: string;
    counter_price_ngn: number | null;
    counter_note: string | null;
    countered_by: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO part_request_quotes (
       id, request_id, vendor_user_id, part_id, price_ngn, eta_minutes, note, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
     ON CONFLICT (request_id, vendor_user_id)
     DO UPDATE SET
       part_id = EXCLUDED.part_id,
       price_ngn = EXCLUDED.price_ngn,
       eta_minutes = EXCLUDED.eta_minutes,
       note = EXCLUDED.note,
       status = 'open',
       counter_price_ngn = NULL,
       counter_note = NULL,
       countered_by = NULL,
       updated_at = NOW()
     RETURNING
       id, request_id, vendor_user_id, part_id, price_ngn, eta_minutes, note,
       status, counter_price_ngn, counter_note, countered_by, created_at, updated_at`,
    [
      quoteId,
      requestId,
      normalizedVendorUserId,
      normalizedPartId,
      normalizedPriceNgn,
      normalizedEtaMinutes,
      normalizedNote || null,
    ],
  );

  await query(
    `UPDATE part_requests
     SET status = 'quoted'
     WHERE id = $1 AND status = 'open'`,
    [requestId],
  );

  log.info({ requestId, vendorUserId: normalizedVendorUserId }, "Quote saved");
  return res.status(201).json({ ok: true, quote: result.rows[0] });
});

router.post("/requests/:requestId/quotes/:quoteId/counter", async (req: Request, res: Response) => {
  const { requestId, quoteId } = req.params;
  const {
    userId,
    priceNgn,
    note,
  } = req.body as {
    userId?: string;
    priceNgn?: number | string;
    note?: string;
  };

  const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
  const normalizedPriceNgn = toNullableInt(priceNgn);
  const normalizedNote = typeof note === "string" ? note.trim() : "";

  if (!normalizedUserId) {
    return res.status(400).json({ ok: false, message: "userId is required" });
  }
  if (!normalizedPriceNgn || normalizedPriceNgn <= 0) {
    return res.status(400).json({ ok: false, message: "priceNgn must be a positive number" });
  }

  const result = await query<{
    id: string;
    counter_price_ngn: number | null;
    counter_note: string | null;
    status: string;
  }>(
    `UPDATE part_request_quotes
     SET counter_price_ngn = $1,
         counter_note = $2,
         countered_by = 'mechanic',
         status = 'countered',
         updated_at = NOW()
     WHERE id = $3 AND request_id = $4
     RETURNING id, counter_price_ngn, counter_note, status`,
    [normalizedPriceNgn, normalizedNote || null, quoteId, requestId],
  );

  if (!result.rows[0]) {
    return res.status(404).json({ ok: false, message: "Quote not found" });
  }

  return res.json({ ok: true, quote: result.rows[0] });
});

router.post("/requests/:requestId/quotes/:quoteId/respond", async (req: Request, res: Response) => {
  const { requestId, quoteId } = req.params;
  const {
    vendorUserId,
    action,
  } = req.body as {
    vendorUserId?: string;
    action?: string;
  };

  const normalizedVendorUserId =
    typeof vendorUserId === "string" ? vendorUserId.trim() : "";
  const normalizedAction = typeof action === "string" ? action.trim().toLowerCase() : "";

  if (!normalizedVendorUserId) {
    return res.status(400).json({ ok: false, message: "vendorUserId is required" });
  }
  if (!["accept_counter", "reject_counter"].includes(normalizedAction)) {
    return res.status(400).json({ ok: false, message: "Invalid action" });
  }

  const sql =
    normalizedAction === "accept_counter"
      ? `UPDATE part_request_quotes
         SET price_ngn = COALESCE(counter_price_ngn, price_ngn),
             note = COALESCE(counter_note, note),
             counter_price_ngn = NULL,
             counter_note = NULL,
             countered_by = NULL,
             status = 'open',
             updated_at = NOW()
         WHERE id = $1 AND request_id = $2 AND vendor_user_id = $3
         RETURNING id, status, price_ngn, note`
      : `UPDATE part_request_quotes
         SET counter_price_ngn = NULL,
             counter_note = NULL,
             countered_by = NULL,
             status = 'open',
             updated_at = NOW()
         WHERE id = $1 AND request_id = $2 AND vendor_user_id = $3
         RETURNING id, status, price_ngn, note`;

  const result = await query(sql, [quoteId, requestId, normalizedVendorUserId]);
  if (!result.rows[0]) {
    return res.status(404).json({ ok: false, message: "Quote not found" });
  }

  return res.json({ ok: true, quote: result.rows[0] });
});

router.post("/requests/:requestId/quotes/:quoteId/accept", async (req: Request, res: Response) => {
  const { requestId, quoteId } = req.params;

  const quoteResult = await query<{ id: string; request_id: string }>(
    `UPDATE part_request_quotes
     SET status = 'accepted', updated_at = NOW()
     WHERE id = $1 AND request_id = $2
     RETURNING id, request_id`,
    [quoteId, requestId],
  );

  if (!quoteResult.rows[0]) {
    return res.status(404).json({ ok: false, message: "Quote not found" });
  }

  await query(
    `UPDATE part_request_quotes
     SET status = CASE WHEN id = $1 THEN status ELSE 'closed' END,
         updated_at = NOW()
     WHERE request_id = $2`,
    [quoteId, requestId],
  );
  await query(
    `UPDATE part_requests
     SET status = 'matched'
     WHERE id = $1`,
    [requestId],
  );

  return res.json({ ok: true, quoteId, requestId });
});

router.get("/requests/:requestId/offers", async (req: Request, res: Response) => {
  const { requestId } = req.params;

  const requestResult = await query<{
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
     WHERE id = $1
     LIMIT 1`,
    [requestId]
  );
  const requestRow = requestResult.rows[0];

  if (!requestRow) {
    return res.status(404).json({ ok: false, message: "Request not found" });
  }

  const quotesResult = await query<{
    id: string;
    request_id: string;
    vendor_user_id: string;
    part_id: string | null;
    price_ngn: number;
    eta_minutes: number | null;
    note: string | null;
    status: string;
    counter_price_ngn: number | null;
    counter_note: string | null;
    countered_by: string | null;
    created_at: string;
    updated_at: string;
    vendor_name: string | null;
    part_name: string | null;
    stock_qty: number | null;
    image_url: string | null;
  }>(
    `SELECT
       q.id,
       q.request_id,
       q.vendor_user_id,
       q.part_id,
       q.price_ngn,
       q.eta_minutes,
       q.note,
       q.status,
       q.counter_price_ngn,
       q.counter_note,
       q.countered_by,
       q.created_at,
       q.updated_at,
       COALESCE(NULLIF(u.first_name, ''), split_part(u.email, '@', 1)) AS vendor_name,
       p.name AS part_name,
       p.stock_qty,
       p.image_url
     FROM part_request_quotes q
     LEFT JOIN users u ON u.id = q.vendor_user_id
     LEFT JOIN parts p ON p.id = q.part_id
     WHERE q.request_id = $1
     ORDER BY
       CASE WHEN q.status = 'accepted' THEN 0 ELSE 1 END,
       q.price_ngn ASC,
       q.created_at DESC`,
    [requestId],
  );

  return res.json({
    ok: true,
    request: {
      id: requestRow.id,
      userId: requestRow.user_id,
      vehicle: requestRow.vehicle,
      partDescription: requestRow.part_description,
      urgency: requestRow.urgency,
      status: requestRow.status,
      createdAt: requestRow.created_at,
    },
    offers: quotesResult.rows.map((quote) => ({
      id: quote.id,
      requestId: quote.request_id,
      partId: quote.part_id,
      vendorUserId: quote.vendor_user_id,
      vendor:
        (typeof quote.vendor_name === "string" && quote.vendor_name.trim()) ||
        "Vendor",
      itemName:
        (typeof quote.part_name === "string" && quote.part_name.trim()) ||
        requestRow.part_description ||
        "Requested part",
      notes: quote.note ?? "",
      eta:
        typeof quote.eta_minutes === "number" && quote.eta_minutes > 0
          ? `${quote.eta_minutes} mins`
          : "ETA unavailable",
      etaMinutes: quote.eta_minutes,
      total: quote.price_ngn,
      currency: "NGN",
      stockQty: quote.stock_qty,
      imageUrl: quote.image_url,
      status: quote.status,
      counterPriceNgn: quote.counter_price_ngn,
      counterNote: quote.counter_note,
      counteredBy: quote.countered_by,
      createdAt: quote.created_at,
      updatedAt: quote.updated_at,
    })),
  });
});

router.get("/:partId", async (req: Request, res: Response) => {
  const { partId } = req.params;
  let rows: Array<{
    id: string;
    name: string;
    description: string | null;
    image_url: string | null;
    user_id: string | null;
    vendor_name: string | null;
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
      user_id: string | null;
      vendor_name: string | null;
      price_ngn: number | null;
      stock_qty: number | null;
      role: string | null;
      created_at: string;
    }>(
      `SELECT
         p.id,
         p.name,
         p.description,
         p.image_url,
         p.user_id,
         COALESCE(NULLIF(u.first_name, ''), split_part(u.email, '@', 1)) AS vendor_name,
         p.price_ngn,
         p.stock_qty,
         p.role,
         p.created_at
       FROM parts p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.id = $1`,
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
      vendor_name: string | null;
      role: string | null;
      created_at: string;
    }>(
      `SELECT id, name, description, image_url, NULL::text AS vendor_name, role, created_at
       FROM parts
       WHERE id = $1`,
      [partId],
    );
    rows = result.rows.map((row) => ({
      ...row,
      user_id: null,
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
      userId: part.user_id,
      vendorName: part.vendor_name,
      imageUrl: part.image_url,
      priceNgn: part.price_ngn,
      stockQty: part.stock_qty,
    },
  });
});

export default router;
