import { Router, Request, Response } from "express";
import { randomBytes } from "crypto";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import path from "path";
import { query } from "../db";
import { requireRoles } from "../middleware/auth";

const router = Router();

const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxImageBytes = Number(process.env.ONBOARDING_IMAGE_MAX_BYTES || 5 * 1024 * 1024);
const maxImagesPerRequest = Number(process.env.ONBOARDING_IMAGE_MAX_COUNT || 5);
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
  uploaded_by: string;
  created_at: Date;
  updated_at: Date;
};

type IncomingImage = {
  originalName?: string;
  fileName?: string;
  name?: string;
  mimeType?: string;
  type?: string;
  dataBase64?: string;
  base64?: string;
  data?: string;
};

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function getExtension(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function sanitizeOriginalName(value: string): string {
  const baseName = path.basename(value || "image");
  const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return sanitized || "image";
}

function normalizeBase64Image(image: IncomingImage): {
  originalName: string;
  mimeType: string;
  buffer: Buffer;
} {
  const originalName = sanitizeOriginalName(
    image.originalName || image.fileName || image.name || "image"
  );
  let mimeType = String(image.mimeType || image.type || "").toLowerCase().trim();
  let base64Data = String(image.dataBase64 || image.base64 || image.data || "").trim();
  const dataUrlMatch = base64Data.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i);

  if (dataUrlMatch) {
    mimeType = dataUrlMatch[1].toLowerCase() === "image/jpg" ? "image/jpeg" : dataUrlMatch[1].toLowerCase();
    base64Data = dataUrlMatch[2];
  }
  if (mimeType === "image/jpg") mimeType = "image/jpeg";
  if (!allowedMimeTypes.has(mimeType)) {
    throw new Error("Only jpg, png, and webp images are supported.");
  }

  const compactBase64 = base64Data.replace(/\s/g, "");
  if (!compactBase64) throw new Error("Image data is required.");

  const buffer = Buffer.from(compactBase64, "base64");
  if (!buffer.length) throw new Error("Image data is invalid.");
  if (buffer.byteLength > maxImageBytes) {
    throw new Error(`Each image must be ${Math.floor(maxImageBytes / 1024 / 1024)}MB or smaller.`);
  }

  return { originalName, mimeType, buffer };
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.use(requireRoles("admin", "staff"));

router.get("/onboarding/images", async (_req: Request, res: Response) => {
  const { rows } = await query<OnboardingImageRow>(
    `SELECT id, original_name, stored_name, mime_type, size, storage_path, access_url, uploaded_by, created_at, updated_at
     FROM onboarding_images
     ORDER BY created_at DESC`
  );

  return res.json({ ok: true, images: rows.map(toResponse) });
});

router.post("/onboarding/images", async (req: Request, res: Response) => {
  const body = req.body as { images?: IncomingImage[]; image?: IncomingImage };
  const incomingImages = Array.isArray(body.images)
    ? body.images
    : body.image
      ? [body.image]
      : [];

  if (!incomingImages.length) {
    return res.status(400).json({ ok: false, message: "At least one image is required" });
  }
  if (incomingImages.length > maxImagesPerRequest) {
    return res.status(400).json({
      ok: false,
      message: `Upload ${maxImagesPerRequest} images or fewer at a time`,
    });
  }

  await mkdir(storageRoot, { recursive: true });
  const createdRows: OnboardingImageRow[] = [];

  for (const incomingImage of incomingImages) {
    let normalized: ReturnType<typeof normalizeBase64Image>;
    try {
      normalized = normalizeBase64Image(incomingImage);
    } catch (err) {
      return res.status(400).json({
        ok: false,
        message: err instanceof Error ? err.message : "Invalid image upload",
      });
    }

    const id = genId("img");
    const storedName = `${id}_${randomBytes(8).toString("hex")}.${getExtension(normalized.mimeType)}`;
    const storagePath = path.resolve(storageRoot, storedName);
    if (!storagePath.startsWith(`${storageRoot}${path.sep}`)) {
      return res.status(400).json({ ok: false, message: "Invalid storage path" });
    }

    await writeFile(storagePath, normalized.buffer, { flag: "wx" });
    const accessUrl = `/admin/onboarding/images/${id}/content`;
    const { rows } = await query<OnboardingImageRow>(
      `INSERT INTO onboarding_images
       (id, original_name, stored_name, mime_type, size, storage_path, access_url, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, original_name, stored_name, mime_type, size, storage_path, access_url, uploaded_by, created_at, updated_at`,
      [
        id,
        normalized.originalName,
        storedName,
        normalized.mimeType,
        normalized.buffer.byteLength,
        storagePath,
        accessUrl,
        req.user?.id ?? null,
      ]
    );
    createdRows.push(rows[0]);
  }

  return res.status(201).json({ ok: true, images: createdRows.map(toResponse) });
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
    "DELETE FROM onboarding_images WHERE id = $1 RETURNING storage_path",
    [req.params.id]
  );
  const deleted = rows[0];
  if (!deleted) return res.status(404).json({ ok: false, message: "Image not found" });

  const resolvedPath = path.resolve(deleted.storage_path);
  if (resolvedPath.startsWith(`${storageRoot}${path.sep}`)) {
    await unlink(resolvedPath).catch(() => undefined);
  }

  return res.json({ ok: true, message: "Image deleted" });
});

export default router;
