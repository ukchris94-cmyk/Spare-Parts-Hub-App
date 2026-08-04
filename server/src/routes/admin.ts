import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { readFile, unlink } from "fs/promises";
import path from "path";
import { query } from "../db";
import { requireRoles } from "../middleware/auth";
import { hashPassword } from "../services/passwords";
import { deleteMediaObject, getMediaObject, mediaReadUrl } from "../services/objectStorage";

const router = Router();

const storageRoot = path.resolve(
  process.env.ONBOARDING_IMAGE_STORAGE_DIR ||
    path.join(process.cwd(), "uploads", "onboarding-images")
);

type OnboardingImageRow = {
  id: string;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size: number;
  storage_path: string;
  access_url: string;
  uploaded_by: string | null;
  vendor_user_id: string | null;
  vendor_name?: string | null;
  vendor_email?: string | null;
  part_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type VendorRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  role: string;
  verified: boolean;
  created_at: Date;
  parts_count?: string | number | null;
  missing_images_count?: string | number | null;
};

function genId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function validatePassword(password: string): string | null {
  if (!password || password.length < 10) return "Password must be at least 10 characters";
  if (password.length > 128) return "Password is too long";
  return null;
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function toCount(value: string | number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toVendorResponse(row: VendorRow) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    role: row.role,
    verified: row.verified,
    displayName: name || row.email.split("@")[0] || row.email,
    partsCount: toCount(row.parts_count),
    missingImagesCount: toCount(row.missing_images_count),
    createdAt: row.created_at,
  };
}

function toResponse(row: OnboardingImageRow) {
  return {
    id: row.id,
    originalName: row.original_name,
    storedName: row.stored_name,
    mimeType: row.mime_type,
    size: row.size,
    accessUrl: row.access_url,
    uploadedBy: row.uploaded_by,
    vendorUserId: row.vendor_user_id,
    vendorName: row.vendor_name ?? null,
    vendorEmail: row.vendor_email ?? null,
    partId: row.part_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.use(requireRoles("admin", "staff"));

router.get("/vendors", async (_req: Request, res: Response) => {
  const { rows } = await query<VendorRow>(
    `SELECT
       u.id, u.first_name, u.last_name, u.email, u.role, u.verified, u.created_at,
       COUNT(p.id)::int AS parts_count,
       COUNT(p.id) FILTER (WHERE p.image_url IS NULL OR p.image_url = '')::int AS missing_images_count
     FROM users u
     LEFT JOIN parts p ON p.user_id = u.id
     WHERE u.role = 'vendor'
     GROUP BY u.id, u.first_name, u.last_name, u.email, u.role, u.verified, u.created_at
     ORDER BY COALESCE(NULLIF(u.first_name, ''), split_part(u.email, '@', 1)), u.email`
  );

  return res.json({ ok: true, vendors: rows.map(toVendorResponse) });
});

router.post("/vendors", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  const normalizedEmail = typeof email === "string" ? email.toLowerCase().trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ ok: false, message: "Valid vendor email is required" });
  }

  const passwordError = validatePassword(password || "");
  if (passwordError) {
    return res.status(400).json({ ok: false, message: passwordError });
  }

  const firstName = normalizeName(req.body?.firstName);
  const lastName = normalizeName(req.body?.lastName);
  const existing = await query<{ id: string }>(
    "SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1",
    [normalizedEmail]
  );
  if (existing.rows.length > 0) {
    return res.status(409).json({ ok: false, message: "A user with this email already exists" });
  }

  const id = genId("usr");
  const passwordHash = await hashPassword(password || "");
  const { rows } = await query<VendorRow>(
    `INSERT INTO users (id, first_name, last_name, email, password_hash, role, verified)
     VALUES ($1, $2, $3, $4, $5, 'vendor', TRUE)
     RETURNING id, first_name, last_name, email, role, verified, created_at`,
    [id, firstName, lastName, normalizedEmail, passwordHash]
  );

  return res.status(201).json({ ok: true, vendor: toVendorResponse(rows[0]) });
});

router.get("/onboarding/images", async (_req: Request, res: Response) => {
  const { rows } = await query<OnboardingImageRow>(
    `SELECT oi.id, oi.original_name, oi.stored_name, oi.mime_type, oi.size, oi.storage_path,
            oi.access_url, oi.uploaded_by, oi.vendor_user_id, oi.part_id, oi.created_at, oi.updated_at,
            COALESCE(NULLIF(v.first_name, ''), split_part(v.email, '@', 1)) AS vendor_name,
            v.email AS vendor_email
     FROM onboarding_images oi
     LEFT JOIN users v ON v.id = oi.vendor_user_id
     ORDER BY oi.created_at DESC`
  );

  const images = await Promise.all(
    rows.map(async (row) => {
      if (!row.storage_path.startsWith("s3://")) return toResponse(row);
      const media = await getMediaObject(row.id);
      return {
        ...toResponse(row),
        accessUrl: media?.status === "verified" ? await mediaReadUrl(media) : null,
      };
    })
  );
  return res.json({ ok: true, images });
});

router.post("/onboarding/images", async (_req: Request, res: Response) => {
  return res.status(410).json({
    ok: false,
    message: "Base64 uploads have been retired. Initialize a private upload at /api/media/uploads.",
  });
});

router.get("/onboarding/images/:id/content", async (req: Request, res: Response) => {
  const { rows } = await query<OnboardingImageRow>(
    `SELECT id, original_name, stored_name, mime_type, size, storage_path, access_url, uploaded_by, created_at, updated_at
     FROM onboarding_images
     WHERE id = $1
     LIMIT 1`,
    [req.params.id]
  );
  const image = rows[0];
  if (!image) return res.status(404).json({ ok: false, message: "Image not found" });

  if (image.storage_path.startsWith("s3://")) {
    const media = await getMediaObject(image.id);
    if (!media || media.status !== "verified") {
      return res.status(404).json({ ok: false, message: "Image not found" });
    }
    return res.redirect(302, await mediaReadUrl(media));
  }

  const resolvedPath = path.resolve(image.storage_path);
  if (!resolvedPath.startsWith(`${storageRoot}${path.sep}`)) {
    return res.status(400).json({ ok: false, message: "Invalid image path" });
  }

  const file = await readFile(resolvedPath);
  res.type(image.mime_type);
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.send(file);
});

router.delete("/onboarding/images/:id", async (req: Request, res: Response) => {
  const { rows } = await query<Pick<OnboardingImageRow, "storage_path">>(
    "SELECT storage_path FROM onboarding_images WHERE id = $1",
    [req.params.id]
  );
  const deleted = rows[0];
  if (!deleted) return res.status(404).json({ ok: false, message: "Image not found" });

  if (deleted.storage_path.startsWith("s3://")) {
    const media = await getMediaObject(String(req.params.id));
    if (media) await deleteMediaObject(media);
  } else {
    const resolvedPath = path.resolve(deleted.storage_path);
    if (resolvedPath.startsWith(`${storageRoot}${path.sep}`)) {
      await unlink(resolvedPath).catch(() => undefined);
    }
  }

  await query("DELETE FROM onboarding_images WHERE id = $1", [req.params.id]);

  return res.json({ ok: true, message: "Image deleted" });
});

export default router;
