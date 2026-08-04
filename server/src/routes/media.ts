import { Request, Response, Router } from "express";
import { requireAuthenticated } from "../middleware/auth";
import { query } from "../db";
import {
  completeMediaUpload,
  createMediaUpload,
  deleteMediaObject,
  getMediaObject,
  publicMediaReadUrl,
  s3StorageUri,
} from "../services/objectStorage";

const router = Router();

function isPrivileged(req: Request): boolean {
  return ["admin", "staff"].includes(req.user?.role || "");
}

function publicApiBase(req: Request): string {
  const configured = process.env.PUBLIC_API_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return `${req.protocol}://${req.get("host")}/api`;
}

// Only product images explicitly linked to a published part are public.
router.get("/:id/content", async (req: Request, res: Response) => {
  const media = await getMediaObject(String(req.params.id));
  const partId = typeof media?.metadata?.partId === "string" ? media.metadata.partId : "";
  if (!media || media.status !== "verified" || media.purpose !== "part_image" || !partId) {
    return res.status(404).json({ ok: false, message: "Image not found" });
  }
  const published = await query<{ found: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM parts WHERE id = $1 AND image_url = $2) AS found",
    [partId, s3StorageUri(media)]
  );
  if (!published.rows[0]?.found) {
    return res.status(404).json({ ok: false, message: "Image not found" });
  }
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.redirect(302, await publicMediaReadUrl(media));
});

router.post("/uploads", requireAuthenticated, async (req: Request, res: Response) => {
  const purpose = req.body?.purpose === "part_image" ? "part_image" : "onboarding_image";
  if (!req.user || (purpose === "onboarding_image" && !isPrivileged(req))) {
    return res.status(403).json({ ok: false, message: "Not authorized to upload this media" });
  }
  if (purpose === "part_image" && !["vendor", "admin", "staff"].includes(req.user.role)) {
    return res.status(403).json({ ok: false, message: "Not authorized to upload part images" });
  }

  const partId = typeof req.body?.partId === "string" ? req.body.partId.trim() : "";
  const vendorUserId = typeof req.body?.vendorUserId === "string" ? req.body.vendorUserId.trim() : "";
  if (purpose === "part_image" && !partId) {
    return res.status(400).json({ ok: false, message: "partId is required for a part image" });
  }
  if (partId) {
    const owner = await query<{ user_id: string | null }>(
      "SELECT user_id FROM parts WHERE id = $1 LIMIT 1",
      [partId]
    );
    if (!owner.rows[0]) return res.status(404).json({ ok: false, message: "Part not found" });
    if (!isPrivileged(req) && owner.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ ok: false, message: "Not authorized to update this part" });
    }
  }

  try {
    const upload = await createMediaUpload({
      ownerId: req.user.id,
      purpose,
      originalName: typeof req.body?.originalName === "string" ? req.body.originalName : "image",
      mimeType: typeof req.body?.mimeType === "string" ? req.body.mimeType.toLowerCase() : "",
      sizeBytes: Number(req.body?.sizeBytes),
      metadata: {
        ...(partId ? { partId } : {}),
        ...(vendorUserId ? { vendorUserId } : {}),
      },
    });
    return res.status(201).json({ ok: true, upload });
  } catch (error) {
    req.log.warn({ err: error, userId: req.user.id }, "Media upload initialization failed");
    return res.status(400).json({
      ok: false,
      message: error instanceof Error ? error.message : "Could not initialize image upload",
    });
  }
});

router.post("/uploads/:id/complete", requireAuthenticated, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ ok: false, message: "Authentication required" });
  const media = await getMediaObject(String(req.params.id));
  if (!media) return res.status(404).json({ ok: false, message: "Media upload not found" });
  if (!isPrivileged(req) && media.owner_id !== req.user.id) {
    return res.status(403).json({ ok: false, message: "Not authorized" });
  }

  try {
    const completed = await completeMediaUpload(media.id);
    const partId = typeof completed.metadata?.partId === "string" ? completed.metadata.partId : "";
    const vendorUserId = typeof completed.metadata?.vendorUserId === "string"
      ? completed.metadata.vendorUserId
      : null;
    const accessUrl = `${publicApiBase(req)}/media/${encodeURIComponent(completed.id)}/content`;

    if (partId && completed.purpose === "part_image") {
      await query("UPDATE parts SET image_url = $1 WHERE id = $2", [s3StorageUri(completed), partId]);
    }
    if (completed.purpose === "onboarding_image") {
      await query(
        `INSERT INTO onboarding_images
           (id, original_name, stored_name, mime_type, size, storage_path, access_url,
            uploaded_by, vendor_user_id, part_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
        [
          completed.id,
          completed.original_name || "image",
          completed.object_key,
          completed.mime_type,
          completed.size_bytes,
          s3StorageUri(completed),
          accessUrl,
          completed.owner_id,
          vendorUserId,
          partId || null,
        ]
      );
    }
    return res.json({
      ok: true,
      media: {
        id: completed.id,
        purpose: completed.purpose,
        mimeType: completed.mime_type,
        size: completed.size_bytes,
        accessUrl: completed.purpose === "part_image" ? accessUrl : null,
        partId: partId || null,
        vendorUserId,
      },
    });
  } catch (error) {
    req.log.warn({ err: error, mediaId: media.id }, "Media upload completion failed");
    return res.status(400).json({
      ok: false,
      message: error instanceof Error ? error.message : "Could not verify image upload",
    });
  }
});

router.delete("/:id", requireAuthenticated, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ ok: false, message: "Authentication required" });
  const media = await getMediaObject(String(req.params.id));
  if (!media) return res.status(404).json({ ok: false, message: "Media not found" });
  if (!isPrivileged(req) && media.owner_id !== req.user.id) {
    return res.status(403).json({ ok: false, message: "Not authorized" });
  }
  await deleteMediaObject(media);
  await query("DELETE FROM onboarding_images WHERE id = $1", [media.id]);
  return res.json({ ok: true });
});

export default router;
