import { Request, Response } from "express";

const MAX_PART_IMAGE_BYTES = 8 * 1024 * 1024;
const INLINE_IMAGE_PATTERN =
  /^data:(image\/(?:avif|gif|heic|heif|jpeg|jpg|png|webp));base64,([a-z0-9+/=\r\n]+)$/i;

function publicApiBaseUrl(req: Request): string {
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

export function publicPartImageUrl(
  req: Request,
  partId: string,
  storedImageUrl: string | null,
): string | null {
  if (!storedImageUrl) return null;
  if (!storedImageUrl.startsWith("data:image/")) return storedImageUrl;

  return `${publicApiBaseUrl(req)}/parts/${encodeURIComponent(partId)}/image`;
}

export function sendPartImage(
  res: Response,
  storedImageUrl: string | null,
): void {
  if (!storedImageUrl) {
    res.status(404).json({ ok: false, message: "Part image not found" });
    return;
  }

  if (/^https?:\/\//i.test(storedImageUrl)) {
    res.redirect(302, storedImageUrl);
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
