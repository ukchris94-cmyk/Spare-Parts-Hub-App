import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { env } from "../config/env";
import { query } from "../db";

const allowedTypes = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);
const maxBytes = Number.parseInt(process.env.MEDIA_MAX_IMAGE_BYTES || "8388608", 10);
let client: S3Client | undefined;

function s3(): S3Client {
  if (!client) client = new S3Client({ region: env.AWS_REGION });
  return client;
}

function bucket(): string {
  const value = process.env.MEDIA_BUCKET?.trim();
  if (!value || !env.AWS_REGION) {
    throw new Error("MEDIA_BUCKET and AWS_REGION are required for media uploads");
  }
  return value;
}

function mediaKey(purpose: string, extension: string): string {
  const now = new Date();
  return `media/${purpose}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}.${extension}`;
}

function safeName(value: string): string {
  return value.split(/[\\/]/).pop()?.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "image";
}

function sniffImage(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export type MediaObjectRow = {
  id: string;
  owner_id: string | null;
  purpose: string;
  bucket: string;
  object_key: string;
  mime_type: string;
  size_bytes: number;
  original_name: string | null;
  status: string;
  metadata: Record<string, unknown>;
};

export async function createMediaUpload(input: {
  ownerId: string;
  purpose: "onboarding_image" | "part_image";
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  metadata?: Record<string, unknown>;
}) {
  const extension = allowedTypes.get(input.mimeType);
  if (!extension) throw new Error("Only JPEG, PNG, and WebP images are supported");
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > maxBytes) {
    throw new Error(`Image must be between 1 byte and ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  }
  const objectBucket = bucket();
  const objectKey = mediaKey(input.purpose, extension);
  const id = `media_${randomUUID()}`;
  const encryption = process.env.MEDIA_KMS_KEY_ID?.trim()
    ? { ServerSideEncryption: "aws:kms" as const, SSEKMSKeyId: process.env.MEDIA_KMS_KEY_ID.trim() }
    : { ServerSideEncryption: "AES256" as const };
  const command = new PutObjectCommand({
    Bucket: objectBucket,
    Key: objectKey,
    ContentType: input.mimeType,
    ...encryption,
    Metadata: { owner: input.ownerId, purpose: input.purpose },
  });
  const uploadUrl = await getSignedUrl(s3(), command, { expiresIn: 600 });
  await query(
    `INSERT INTO media_objects
       (id, owner_id, purpose, bucket, object_key, mime_type, size_bytes,
        original_name, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9::jsonb)`,
    [
      id,
      input.ownerId,
      input.purpose,
      objectBucket,
      objectKey,
      input.mimeType,
      input.sizeBytes,
      safeName(input.originalName),
      JSON.stringify(input.metadata || {}),
    ]
  );
  return {
    id,
    uploadUrl,
    expiresIn: 600,
    headers: {
      "Content-Type": input.mimeType,
      "x-amz-server-side-encryption": encryption.ServerSideEncryption,
      ...(encryption.ServerSideEncryption === "aws:kms"
        ? { "x-amz-server-side-encryption-aws-kms-key-id": process.env.MEDIA_KMS_KEY_ID!.trim() }
        : {}),
    },
  };
}

export async function getMediaObject(id: string): Promise<MediaObjectRow | null> {
  const result = await query<MediaObjectRow>(
    `SELECT id, owner_id, purpose, bucket, object_key, mime_type, size_bytes,
            original_name, status, metadata
     FROM media_objects WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function completeMediaUpload(id: string): Promise<MediaObjectRow> {
  const media = await getMediaObject(id);
  if (!media) throw new Error("Media upload was not found");
  if (media.status === "verified") return media;
  const head = await s3().send(new HeadObjectCommand({ Bucket: media.bucket, Key: media.object_key }));
  const actualSize = Number(head.ContentLength || 0);
  const actualType = String(head.ContentType || "").toLowerCase();
  const sample = await s3().send(
    new GetObjectCommand({ Bucket: media.bucket, Key: media.object_key, Range: "bytes=0-15" })
  );
  const bytes = sample.Body ? Buffer.from(await sample.Body.transformToByteArray()) : Buffer.alloc(0);
  const sniffedType = sniffImage(bytes);
  if (
    actualSize !== media.size_bytes ||
    actualSize <= 0 ||
    actualSize > maxBytes ||
    actualType !== media.mime_type ||
    sniffedType !== media.mime_type
  ) {
    await s3().send(new DeleteObjectCommand({ Bucket: media.bucket, Key: media.object_key }));
    await query(
      "UPDATE media_objects SET status = 'rejected', failure_reason = 'File validation failed' WHERE id = $1",
      [id]
    );
    throw new Error("Uploaded file failed image validation");
  }
  const updated = await query<MediaObjectRow>(
    `UPDATE media_objects SET status = 'verified', verified_at = NOW()
     WHERE id = $1
     RETURNING id, owner_id, purpose, bucket, object_key, mime_type, size_bytes,
               original_name, status, metadata`,
    [id]
  );
  return updated.rows[0];
}

export async function mediaReadUrl(media: Pick<MediaObjectRow, "bucket" | "object_key">): Promise<string> {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: media.bucket, Key: media.object_key }),
    { expiresIn: 900 }
  );
}

export async function publicMediaReadUrl(
  media: Pick<MediaObjectRow, "bucket" | "object_key">
): Promise<string> {
  const cdn = process.env.MEDIA_CDN_URL?.trim().replace(/\/+$/, "");
  if (cdn) return `${cdn}/${media.object_key.split("/").map(encodeURIComponent).join("/")}`;
  return mediaReadUrl(media);
}

export async function mediaReadUrlForStorageUri(uri: string): Promise<string | null> {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match || match[1] !== bucket()) return null;
  const result = await query<Pick<MediaObjectRow, "bucket" | "object_key">>(
    `SELECT bucket, object_key
     FROM media_objects
     WHERE bucket = $1 AND object_key = $2 AND status = 'verified'
       AND purpose = 'part_image' AND deleted_at IS NULL
     LIMIT 1`,
    [match[1], match[2]]
  );
  return result.rows[0] ? publicMediaReadUrl(result.rows[0]) : null;
}

export async function deleteMediaObject(media: MediaObjectRow): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: media.bucket, Key: media.object_key }));
  await query("UPDATE media_objects SET status = 'deleted', deleted_at = NOW() WHERE id = $1", [media.id]);
}

export function s3StorageUri(media: Pick<MediaObjectRow, "bucket" | "object_key">): string {
  return `s3://${media.bucket}/${media.object_key}`;
}
