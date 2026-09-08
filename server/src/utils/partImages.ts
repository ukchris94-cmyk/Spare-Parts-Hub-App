import { Request, Response } from "express";
import { query } from "../db";
import { mediaReadUrlForStorageUri } from "../services/objectStorage";

const MAX_PART_IMAGE_BYTES = 8 * 1024 * 1024;
const INLINE_IMAGE_PATTERN =
  /^data:(image\/(?:avif|gif|heic|heif|jpeg|jpg|png|webp));base64,([a-z0-9+/=\r\n]+)$/i;

export function publicApiBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_API_URL?.trim().replace(/\/+$/, "");
  if (configured) {
    const url = new URL(configured);
    const pathname = url.pathname.replace(/\/+$/, "");
    return pathname && pathname !== "/"
      ? `${url.origin}${pathname}`
      : `${url.origin}/api`;
  }

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
  imageKind: "inventory" | "catalog_reference";
  sourceName: string | null;
  sourceUrl: string | null;
  licenseName: string | null;
  licenseUrl: string | null;
  attribution: string | null;
};

export async function loadPartImageGalleries(
  req: Request,
  parts: Array<{ id: string; image_url: string | null }>,
  privateRead = false,
): Promise<Map<string, PublicPartImage[]>> {
  const galleries = new Map<string, PublicPartImage[]>();
  if (parts.length === 0) return galleries;

  const result = await query<{
    part_id: string;
    media_id: string;
    storage_uri: string;
    image_kind: "inventory" | "catalog_reference";
    source_name: string | null;
    source_url: string | null;
    license_name: string | null;
    license_url: string | null;
    attribution: string | null;
  }>(
    `SELECT pi.part_id, pi.media_id, pi.storage_uri, pi.image_kind, pi.source_name,
            pi.source_url, pi.license_name, pi.license_url, pi.attribution
     FROM part_images pi
     JOIN media_objects mo ON mo.id = pi.media_id
     WHERE pi.part_id = ANY($1::text[])
       AND mo.status = 'verified'
       AND mo.deleted_at IS NULL
     ORDER BY pi.part_id,
              CASE WHEN pi.image_kind = 'inventory' THEN 0 ELSE 1 END,
              pi.sort_order,
              pi.created_at`,
    [parts.map((part) => part.id)],
  );

  const primaryByPart = new Map(parts.map((part) => [part.id, part.image_url]));
  for (const row of result.rows) {
    const current = galleries.get(row.part_id) || [];
    const privateUrl = privateRead ? await mediaReadUrlForStorageUri(row.storage_uri) : null;
    current.push({
      id: row.media_id,
      url: privateUrl || `${publicApiBaseUrl(req)}/media/${encodeURIComponent(row.media_id)}/content`,
      isPrimary: primaryByPart.get(row.part_id) === row.storage_uri,
      imageKind: row.image_kind,
      sourceName: row.source_name,
      sourceUrl: row.source_url,
      licenseName: row.license_name,
      licenseUrl: row.license_url,
      attribution: row.attribution,
    });
    galleries.set(row.part_id, current);
  }

  for (const part of parts) {
    const current = galleries.get(part.id) || [];
    if (part.image_url && !current.some((image) => image.isPrimary)) {
      const privatePrimary = privateRead && part.image_url.startsWith("s3://")
        ? await mediaReadUrlForStorageUri(part.image_url)
        : null;
      current.unshift({
        id: null,
        url: privatePrimary || publicPartImageUrl(req, part.id, part.image_url) || "",
        isPrimary: true,
        imageKind: "inventory",
        sourceName: null,
        sourceUrl: null,
        licenseName: null,
        licenseUrl: null,
        attribution: null,
      });
    }
    current.sort((left, right) => {
      const kindOrder = Number(left.imageKind === "catalog_reference") - Number(right.imageKind === "catalog_reference");
      return kindOrder || Number(right.isPrimary) - Number(left.isPrimary);
    });
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
