import { Request, Response, Router } from "express";
import { requireAuthenticated } from "../middleware/auth";
import { query, withClient } from "../db";
import {
  completeMediaUpload,
  createMediaUpload,
  deleteMediaObject,
  getMediaObject,
  publicMediaReadUrl,
  s3StorageUri,
} from "../services/objectStorage";

const router = Router();
const MAX_PART_IMAGES = 8;

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
    `SELECT EXISTS(
       SELECT 1 FROM parts WHERE id = $1 AND image_url = $2
       UNION ALL
       SELECT 1 FROM part_images WHERE part_id = $1 AND storage_uri = $2
     ) AS found`,
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
    const owner = await query<{ user_id: string | null; image_count: string }>(
      `SELECT
         p.user_id,
         (
           SELECT COUNT(*) FROM part_images pi WHERE pi.part_id = p.id
         ) + CASE
           WHEN p.image_url IS NOT NULL
             AND p.image_url <> ''
             AND NOT EXISTS (
               SELECT 1 FROM part_images pi
               WHERE pi.part_id = p.id AND pi.storage_uri = p.image_url
             )
           THEN 1 ELSE 0
         END AS image_count
       FROM parts p
       WHERE p.id = $1
       LIMIT 1`,
      [partId]
    );
    if (!owner.rows[0]) return res.status(404).json({ ok: false, message: "Part not found" });
    if (!isPrivileged(req) && owner.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ ok: false, message: "Not authorized to update this part" });
    }
    if (purpose === "part_image" && Number(owner.rows[0].image_count) >= MAX_PART_IMAGES) {
      return res.status(409).json({
        ok: false,
        message: `A product can have at most ${MAX_PART_IMAGES} photos`,
      });
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
      const storageUri = s3StorageUri(completed);
      await withClient(async (client) => {
        await client.query("BEGIN");
        try {
          await client.query("SELECT id FROM parts WHERE id = $1 FOR UPDATE", [partId]);
          const existing = await client.query(
            "SELECT 1 FROM part_images WHERE media_id = $1 LIMIT 1",
            [completed.id],
          );
          if (!existing.rows[0]) {
            const count = await client.query<{ count: string }>(
              `SELECT (
                 (SELECT COUNT(*) FROM part_images pi WHERE pi.part_id = p.id)
                 + CASE
                   WHEN p.image_url IS NOT NULL
                     AND p.image_url <> ''
                     AND NOT EXISTS (
                       SELECT 1 FROM part_images pi
                       WHERE pi.part_id = p.id AND pi.storage_uri = p.image_url
                     )
                   THEN 1 ELSE 0
                 END
               )::text AS count
               FROM parts p
               WHERE p.id = $1`,
              [partId],
            );
            if (Number(count.rows[0]?.count || 0) >= MAX_PART_IMAGES) {
              throw new Error(`A product can have at most ${MAX_PART_IMAGES} photos`);
            }
            await client.query(
              `INSERT INTO part_images (media_id, part_id, storage_uri, sort_order)
               SELECT $1, $2, $3, COALESCE(MAX(sort_order), -1) + 1
               FROM part_images
               WHERE part_id = $2`,
              [completed.id, partId, storageUri],
            );
          }
          await client.query(
            `UPDATE parts
             SET image_url = CASE
               WHEN image_url IS NULL OR image_url = '' THEN $1
               ELSE image_url
             END
             WHERE id = $2`,
            [storageUri, partId],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
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
  const storageUri = s3StorageUri(media);
  const linkedParts = media.purpose === "part_image"
    ? await query<{ id: string; user_id: string | null }>(
        `SELECT DISTINCT p.id, p.user_id
         FROM parts p
         LEFT JOIN part_images pi ON pi.part_id = p.id
         WHERE p.image_url = $1 OR pi.media_id = $2`,
        [storageUri, media.id],
      )
    : { rows: [] as Array<{ id: string; user_id: string | null }> };
  const ownsLinkedPart = linkedParts.rows.some((part) => part.user_id === req.user?.id);
  if (!isPrivileged(req) && media.owner_id !== req.user.id && !ownsLinkedPart) {
    return res.status(403).json({ ok: false, message: "Not authorized" });
  }
  await deleteMediaObject(media);
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("DELETE FROM onboarding_images WHERE id = $1", [media.id]);
      await client.query("DELETE FROM part_images WHERE media_id = $1", [media.id]);
      await client.query(
        `UPDATE parts p
         SET image_url = (
           SELECT pi.storage_uri
           FROM part_images pi
           WHERE pi.part_id = p.id
           ORDER BY pi.sort_order, pi.created_at
           LIMIT 1
         )
         WHERE p.image_url = $1`,
        [storageUri],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
  return res.json({ ok: true });
});

export default router;
