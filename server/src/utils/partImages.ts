import { Request, Response } from "express";
import { query } from "../db";
import { mediaReadUrlForStorageUri } from "../services/objectStorage";

const MAX_PART_IMAGE_BYTES = 8 * 1024 * 1024;
const INLINE_IMAGE_PATTERN =
  /^data:(image\/(?:avif|gif|heic|heif|jpeg|jpg|png|webp));base64,([a-z0-9+/=\r\n]+)$/i;

export function publicApiBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_API_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;

  const host = req.get("host")?.trim();
  if (!host) return "/api";

  const forwardedProtocol = req
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : req.secure || !localHost
        ? "https"
        : "http";

  return `${protocol}://${host}/api`;
}

export type PublicPartImage = {
  id: string | null;
  url: string;
  isPrimary: boolean;
};

export async function loadPartImageGalleries(
  req: Request,
  parts: Array<{ id: string; image_url: string | null }>,
): Promise<Map<string, PublicPartImage[]>> {
  const galleries = new Map<string, PublicPartImage[]>();
  if (parts.length === 0) return galleries;

  const result = await query<{
    part_id: string;
    media_id: string;
    storage_uri: string;
  }>(
    `SELECT pi.part_id, pi.media_id, pi.storage_uri
     FROM part_images pi
     JOIN media_objects mo ON mo.id = pi.media_id
     WHERE pi.part_id = ANY($1::text[])
       AND mo.status = 'verified'
       AND mo.deleted_at IS NULL
     ORDER BY pi.part_id, pi.sort_order, pi.created_at`,
    [parts.map((part) => part.id)],
  );

  const primaryByPart = new Map(parts.map((part) => [part.id, part.image_url]));
  for (const row of result.rows) {
    const current = galleries.get(row.part_id) || [];
    current.push({
      id: row.media_id,
      url: `${publicApiBaseUrl(req)}/media/${encodeURIComponent(row.media_id)}/content`,
      isPrimary: primaryByPart.get(row.part_id) === row.storage_uri,
    });
    galleries.set(row.part_id, current);
  }

  for (const part of parts) {
    const current = galleries.get(part.id) || [];
    if (part.image_url && !current.some((image) => image.isPrimary)) {
      current.unshift({
        id: null,
        url: publicPartImageUrl(req, part.id, part.image_url) || "",
        isPrimary: true,
      });
    }
    current.sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary));
    galleries.set(part.id, current.filter((image) => image.url));
  }

  return galleries;
}

export function publicPartImageUrl(
  req: Request,
  partId: string,
  storedImageUrl: string | null,
): string | null {
  if (!storedImageUrl) return null;
  if (!storedImageUrl.startsWith("data:image/") && !storedImageUrl.startsWith("s3://")) {
    return storedImageUrl;
  }

  return `${publicApiBaseUrl(req)}/parts/${encodeURIComponent(partId)}/image`;
}

export async function sendPartImage(
  res: Response,
  storedImageUrl: string | null,
): Promise<void> {
  if (!storedImageUrl) {
    res.status(404).json({ ok: false, message: "Part image not found" });
    return;
  }

  if (/^https?:\/\//i.test(storedImageUrl)) {
    res.redirect(302, storedImageUrl);
    return;
  }

  if (storedImageUrl.startsWith("s3://")) {
    const signedUrl = await mediaReadUrlForStorageUri(storedImageUrl);
    if (!signedUrl) {
      res.status(404).json({ ok: false, message: "Part image not found" });
      return;
    }
    res.redirect(302, signedUrl);
    return;
  }

  const match = INLINE_IMAGE_PATTERN.exec(storedImageUrl);
  if (!match) {
    res.status(415).json({
      ok: false,
      message: "Stored part image format is not supported",
    });
    return;
  }

  const [, contentType, encoded] = match;
  const image = Buffer.from(encoded.replace(/\s/g, ""), "base64");
  if (!image.length || image.length > MAX_PART_IMAGE_BYTES) {
    res.status(413).json({
      ok: false,
      message: "Stored part image is empty or too large",
    });
    return;
  }

  res.set({
    "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    "Content-Type": contentType.toLowerCase(),
    "X-Content-Type-Options": "nosniff",
  });
  res.send(image);
}
