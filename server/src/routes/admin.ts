import { Router, Request, Response } from "express";
import { createHmac, randomInt, randomUUID } from "crypto";
import { readFile, unlink } from "fs/promises";
import path from "path";
import { env } from "../config/env";
import { query } from "../db";
import { requireRoles } from "../middleware/auth";
import { createChallenge } from "../services/authChallenges";
import { InvalidPhoneNumberError, maskPhone, normalizeNigerianPhone } from "../services/phoneNumbers";
import { hashPassword } from "../services/passwords";
import { sendTransactionalEmail } from "../services/email";
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
  business_name: string | null;
  business_type: string | null;
  specialization: string | null;
  state: string | null;
  city: string | null;
  email: string | null;
  phone_e164: string | null;
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

function verificationHash(email: string, code: string): string {
  const secret = env.AUTH_TOKEN_SECRET || "quickserve-development-verification-secret";
  return createHmac("sha256", secret).update(`${email}:${code}`).digest("hex");
}

async function issueEmailVerification(email: string): Promise<void> {
  const code = randomInt(100_000, 1_000_000).toString();
  await query(
    `INSERT INTO verification_codes (email, code, code_hash, expires_at, attempt_count, last_sent_at, created_at)
     VALUES ($1, NULL, $2, NOW() + INTERVAL '10 minutes', 0, NOW(), NOW())
     ON CONFLICT (email) DO UPDATE SET code = NULL, code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at, attempt_count = 0, last_sent_at = NOW()`,
    [email, verificationHash(email, code)]
  );
  await sendTransactionalEmail({
    to: email,
    subject: "Your QuickServe verification code",
    text: `Your QuickServe verification code is ${code}. It expires in 10 minutes. Never share this code with anyone.`,
    template: "email-verification",
  });
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
  const roleLabel = row.role === "mechanic" ? "Mechanic" : "Vendor";
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    role: row.role,
    verified: row.verified,
    phone: row.phone_e164,
    businessName: row.business_name,
    businessType: row.business_type,
    specialization: row.specialization,
    state: row.state,
    city: row.city,
    displayName: row.business_name || name || row.email?.split("@")[0] || (row.phone_e164 ? `${roleLabel} ${row.phone_e164.slice(-4)}` : roleLabel),
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
       u.id, u.first_name, u.last_name, u.business_name, u.business_type, u.specialization,
       u.state, u.city, u.email, u.phone_e164, u.role, u.verified, u.created_at,
       COUNT(p.id)::int AS parts_count,
       COUNT(p.id) FILTER (WHERE p.image_url IS NULL OR p.image_url = '')::int AS missing_images_count
     FROM users u
     LEFT JOIN parts p ON p.user_id = u.id
     WHERE u.role = 'vendor'
     GROUP BY u.id, u.first_name, u.last_name, u.business_name, u.business_type, u.specialization,
              u.state, u.city, u.email, u.phone_e164, u.role, u.verified, u.created_at
     ORDER BY COALESCE(NULLIF(u.business_name, ''), NULLIF(u.first_name, ''), split_part(u.email, '@', 1), u.phone_e164), u.email NULLS LAST`
  );

  return res.json({ ok: true, vendors: rows.map(toVendorResponse) });
});

router.post("/vendors", async (req: Request, res: Response) => {
  const { authMethod = "email", email, phone, password, smsSecurityConsent, whatsappSecurityConsent } = req.body as {
    authMethod?: "email" | "phone";
    email?: string;
    phone?: string;
    password?: string;
    smsSecurityConsent?: boolean;
    whatsappSecurityConsent?: boolean;
  };
  const passwordError = validatePassword(password || "");
  if (passwordError) {
    return res.status(400).json({ ok: false, message: passwordError });
  }
  const firstName = normalizeName(req.body?.firstName);
  const lastName = normalizeName(req.body?.lastName);
  const businessName = normalizeName(req.body?.businessName);
  const businessType = normalizeName(req.body?.businessType);
  const state = normalizeName(req.body?.state);
  const city = normalizeName(req.body?.city);
  if (!businessName || businessName.length > 160) {
    return res.status(400).json({ ok: false, message: "Vendor business name is required" });
  }

  if (authMethod === "email") {
    const normalizedEmail = (email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ ok: false, message: "Enter a valid email address" });
    }
    const existing = await query<{ id: string }>(
      "SELECT id FROM users WHERE LOWER(email) = $1 AND deleted_at IS NULL LIMIT 1",
      [normalizedEmail]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ ok: false, message: "A user with this email already exists" });
    }
    const id = genId("usr");
    const passwordHash = await hashPassword(password || "");
    const { rows } = await query<VendorRow>(
      `INSERT INTO users
         (id, first_name, last_name, business_name, business_type, state, city,
          email, password_hash, role, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'vendor', FALSE)
       RETURNING id, first_name, last_name, business_name, business_type, specialization,
                 state, city, email, phone_e164, role, verified, created_at`,
      [id, firstName, lastName, businessName, businessType, state, city, normalizedEmail, passwordHash]
    );
    try {
      await issueEmailVerification(normalizedEmail);
    } catch (error) {
      req.log.warn({ err: error, vendorUserId: id }, "Staff-created vendor email delivery failed");
      return res.status(201).json({
        ok: true,
        vendor: toVendorResponse(rows[0]),
        verificationPending: true,
        message: "Vendor created, but the verification email could not be delivered. The vendor can request another code from the login screen.",
      });
    }
    return res.status(201).json({ ok: true, vendor: toVendorResponse(rows[0]) });
  }

  if (authMethod !== "phone") {
    return res.status(400).json({ ok: false, message: "Choose email or phone signup" });
  }
  if (!env.PHONE_AUTH_ENABLED) {
    return res.status(503).json({
      ok: false,
      message: "Phone authentication is not available yet. Create this vendor with email instead.",
    });
  }
  if (smsSecurityConsent !== true && whatsappSecurityConsent !== true) {
    return res.status(400).json({
      ok: false,
      message: "Confirm that the vendor agreed to receive SMS security codes.",
    });
  }

  let phoneE164: string;
  try {
    phoneE164 = normalizeNigerianPhone(phone || "");
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) {
      return res.status(400).json({ ok: false, message: error.message });
    }
    throw error;
  }

  const existing = await query<{ id: string }>(
    "SELECT id FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL LIMIT 1",
    [phoneE164]
  );
  if (existing.rows.length > 0) {
    return res.status(409).json({ ok: false, message: "A user with this phone number already exists" });
  }

  const id = genId("usr");
  const passwordHash = await hashPassword(password || "");
  const { rows } = await query<VendorRow>(
    `INSERT INTO users
       (id, first_name, last_name, business_name, business_type, state, city,
        phone, phone_e164, email, password_hash, role, verified, whatsapp_security_consent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, NULL, $9, 'vendor', FALSE, NOW())
     RETURNING id, first_name, last_name, business_name, business_type, specialization,
               state, city, email, phone_e164, role, verified, created_at`,
    [id, firstName, lastName, businessName, businessType, state, city, phoneE164, passwordHash]
  );

  let challenge;
  try {
    challenge = await createChallenge({
      userId: id,
      purpose: "signup",
      phoneE164,
      req,
      metadata: { createdByStaff: true, smsSecurityConsent: true },
    });
  } catch (error) {
    req.log.warn({ err: error, vendorUserId: id }, "Staff-created vendor OTP delivery failed");
    return res.status(201).json({
      ok: true,
      vendor: toVendorResponse(rows[0]),
      verificationPending: true,
      message: "Vendor created, but the verification code could not be delivered. The vendor can request another code when signing in.",
    });
  }

  return res.status(201).json({
    ok: true,
    vendor: toVendorResponse(rows[0]),
    challenge: { ...challenge, destination: maskPhone(phoneE164) },
  });
});

router.get("/businesses", async (_req: Request, res: Response) => {
  const { rows } = await query<VendorRow>(
    `SELECT
       u.id, u.first_name, u.last_name, u.business_name, u.business_type, u.specialization,
       u.state, u.city, u.email, u.phone_e164, u.role, u.verified, u.created_at,
       COUNT(p.id)::int AS parts_count,
       COUNT(p.id) FILTER (WHERE p.image_url IS NULL OR p.image_url = '')::int AS missing_images_count
     FROM users u
     LEFT JOIN parts p ON p.user_id = u.id
     WHERE u.role IN ('vendor', 'mechanic') AND u.deleted_at IS NULL
     GROUP BY u.id, u.first_name, u.last_name, u.business_name, u.business_type, u.specialization,
              u.state, u.city, u.email, u.phone_e164, u.role, u.verified, u.created_at
     ORDER BY u.role, COALESCE(NULLIF(u.business_name, ''), NULLIF(u.first_name, ''), u.email, u.phone_e164)`
  );

  return res.json({ ok: true, businesses: rows.map(toVendorResponse) });
});

router.patch("/businesses/:userId", async (req: Request, res: Response) => {
  const userId = String(req.params.userId || "").trim();
  const firstName = normalizeName(req.body?.firstName);
  const lastName = normalizeName(req.body?.lastName);
  const businessName = normalizeName(req.body?.businessName);
  const businessType = normalizeName(req.body?.businessType);
  const specialization = normalizeName(req.body?.specialization);
  const state = normalizeName(req.body?.state);
  const city = normalizeName(req.body?.city);

  if (!userId) {
    return res.status(400).json({ ok: false, message: "Business account is required" });
  }
  if (!businessName || businessName.length > 160) {
    return res.status(400).json({ ok: false, message: "Business name is required" });
  }
  if ([businessType, specialization].some((value) => (value?.length || 0) > 240)) {
    return res.status(400).json({ ok: false, message: "Business details are too long" });
  }

  const { rows } = await query<VendorRow>(
    `UPDATE users
     SET first_name = $2,
         last_name = $3,
         business_name = $4,
         business_type = CASE WHEN role = 'vendor' THEN $5 ELSE NULL END,
         specialization = CASE WHEN role = 'mechanic' THEN $6 ELSE NULL END,
         state = $7,
         city = $8
     WHERE id = $1
       AND role IN ('vendor', 'mechanic')
       AND deleted_at IS NULL
     RETURNING id, first_name, last_name, business_name, business_type, specialization,
               state, city, email, phone_e164, role, verified, created_at`,
    [userId, firstName, lastName, businessName, businessType, specialization, state, city]
  );
  if (!rows[0]) {
    return res.status(404).json({ ok: false, message: "Vendor or mechanic account not found" });
  }

  return res.json({ ok: true, business: toVendorResponse(rows[0]) });
});

router.get("/onboarding/images", async (_req: Request, res: Response) => {
  const { rows } = await query<OnboardingImageRow>(
    `SELECT oi.id, oi.original_name, oi.stored_name, oi.mime_type, oi.size, oi.storage_path,
            oi.access_url, oi.uploaded_by, oi.vendor_user_id, oi.part_id, oi.created_at, oi.updated_at,
            COALESCE(NULLIF(v.business_name, ''), NULLIF(v.first_name, ''), split_part(v.email, '@', 1)) AS vendor_name,
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
