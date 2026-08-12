import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "crypto";
import { Request, Response, Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { env } from "../config/env";
import { pool, query } from "../db";
import {
  authenticateRequest,
  createSessionTokens,
  requireAuthenticated,
  revokeAllUserSessions,
  revokeRefreshToken,
  revokeSession,
  rotateRefreshToken,
} from "../middleware/auth";
import {
  ChallengeError,
  createChallenge,
  resendChallenge,
  resetTokenHash,
  verifyChallenge,
} from "../services/authChallenges";
import { sendTransactionalEmail } from "../services/email";
import { InvalidPhoneNumberError, maskPhone, normalizeNigerianPhone } from "../services/phoneNumbers";
import { hashPassword, verifyPassword } from "../services/passwords";

const router = Router();
const PUBLIC_ROLES = ["mechanic", "vendor", "dispatcher", "user"] as const;
const PRIVILEGED_ROLES = new Set(["admin", "staff"]);

router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.isProduction ? 40 : 500,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { ok: false, message: "Too many authentication requests. Please try again later." },
  })
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.isProduction ? 10 : 500,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { ok: false, message: "Too many failed attempts. Please try again later." },
});

const messageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.isProduction ? 20 : 500,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { ok: false, message: "Too many code requests. Please try again later." },
});

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(10, "Password must be at least 10 characters").max(128, "Password is too long");

function parseBody<T>(schema: z.ZodType<T>, req: Request, res: Response): T | undefined {
  const parsed = schema.safeParse(req.body);
  if (parsed.success) return parsed.data;
  res.status(400).json({ ok: false, message: parsed.error.issues[0]?.message || "Invalid request" });
  return undefined;
}

function normalizeName(value?: string): string | null {
  const trimmed = value?.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function splitLegacyName(fullName?: string): { firstName: string | null; lastName: string | null } {
  const normalized = fullName?.trim().replace(/\s+/g, " ");
  if (!normalized) return { firstName: null, lastName: null };
  const [first, ...rest] = normalized.split(" ");
  return { firstName: normalizeName(first), lastName: normalizeName(rest.join(" ")) };
}

function identifier(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function challengeFailure(error: unknown, res: Response): boolean {
  if (error instanceof ChallengeError) {
    res.status(error.status).json({ ok: false, code: error.code, message: error.message });
    return true;
  }
  if (error instanceof InvalidPhoneNumberError) {
    res.status(400).json({ ok: false, code: "PHONE_INVALID", message: error.message });
    return true;
  }
  return false;
}

function ensurePhoneAuth(res: Response): boolean {
  if (env.PHONE_AUTH_ENABLED) return true;
  res.status(503).json({ ok: false, code: "PHONE_AUTH_NOT_CONFIGURED", message: "Phone authentication is not available yet." });
  return false;
}

const signupSchema = z.object({
  role: z.enum(PUBLIC_ROLES),
  phone: z.string().trim().min(7).max(30),
  email: emailSchema.optional(),
  password: passwordSchema,
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  fullName: z.string().trim().max(160).optional(),
  smsSecurityConsent: z.boolean().optional(),
  whatsappSecurityConsent: z.boolean().optional(),
  whatsappTransactionConsent: z.boolean().default(false),
}).passthrough();

router.post("/signup", messageLimiter, async (req: Request, res: Response) => {
  if (!ensurePhoneAuth(res)) return;
  const body = parseBody(signupSchema, req, res);
  if (!body) return;
  if (body.smsSecurityConsent !== true && body.whatsappSecurityConsent !== true) {
    res.status(400).json({ ok: false, message: "Consent to receive SMS security codes is required." });
    return;
  }

  let phoneE164: string;
  try {
    phoneE164 = normalizeNigerianPhone(body.phone);
  } catch (error) {
    if (challengeFailure(error, res)) return;
    throw error;
  }

  const legacyName = splitLegacyName(body.fullName);
  const firstName = normalizeName(body.firstName) ?? legacyName.firstName;
  const lastName = normalizeName(body.lastName) ?? legacyName.lastName;
  const userId = identifier("usr");
  const passwordHash = await hashPassword(body.password);

  try {
    await query(
      `INSERT INTO users
         (id, first_name, last_name, phone, phone_e164, email, password_hash, role, verified,
          whatsapp_security_consent_at, whatsapp_transaction_consent_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, FALSE, NOW(),
               CASE WHEN $8 THEN NOW() ELSE NULL END)`,
      [userId, firstName, lastName, phoneE164, body.email || null, passwordHash, body.role, body.whatsappTransactionConsent]
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    const existing = await query<{ id: string; verified: boolean }>(
      "SELECT id, verified FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL LIMIT 1",
      [phoneE164]
    );
    if (existing.rows[0] && !existing.rows[0].verified) {
      try {
        const challenge = await createChallenge({
          userId: existing.rows[0].id,
          purpose: "signup",
          phoneE164,
          req,
          metadata: { smsSecurityConsent: true },
        });
        res.status(409).json({
          ok: false,
          code: "ACCOUNT_UNVERIFIED",
          message: "This account still needs phone verification.",
          ...challenge,
          maskedPhone: maskPhone(phoneE164),
        });
        return;
      } catch (sendError) {
        if (challengeFailure(sendError, res)) return;
        throw sendError;
      }
    }
    res.status(409).json({ ok: false, code: "ACCOUNT_EXISTS", message: "Account already exists. Please log in." });
    return;
  }

  try {
    const challenge = await createChallenge({
      userId,
      purpose: "signup",
      phoneE164,
      req,
      metadata: { smsSecurityConsent: true },
    });
    req.log.info({ userId, role: body.role }, "Phone-first user account created");
    res.status(201).json({
      ok: true,
      message: "Account created. Verification code sent by SMS.",
      role: body.role,
      phone: phoneE164,
      maskedPhone: maskPhone(phoneE164),
      ...challenge,
    });
  } catch (error) {
    req.log.error({ err: error, userId }, "Signup OTP delivery failed");
    if (challengeFailure(error, res)) return;
    res.status(503).json({ ok: false, code: "OTP_DELIVERY_FAILED", message: "Your account was created, but the code could not be sent. Try again shortly." });
  }
});

router.post("/verify-phone", loginLimiter, async (req: Request, res: Response) => {
  const body = parseBody(
    z.object({ challengeId: z.string().min(10).max(100), code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") }),
    req,
    res
  );
  if (!body) return;
  try {
    const verified = await verifyChallenge({
      challengeId: body.challengeId,
      code: body.code,
      expectedPurpose: "signup",
    });
    res.json({ ok: true, message: "Phone number verified. Your account is active.", phone: verified.phoneE164 });
  } catch (error) {
    if (challengeFailure(error, res)) return;
    throw error;
  }
});

router.post("/resend-code", messageLimiter, async (req: Request, res: Response) => {
  const challengeBody = z.object({
    challengeId: z.string().min(10).max(100),
    channel: z.literal("sms").default("sms"),
  }).safeParse(req.body);
  if (challengeBody.success) {
    try {
      const requestingUser = await authenticateRequest(req);
      const challenge = await resendChallenge(
        challengeBody.data.challengeId,
        challengeBody.data.channel,
        req,
        requestingUser?.id
      );
      res.json({ ok: true, message: "Verification code sent by SMS.", ...challenge });
    } catch (error) {
      if (challengeFailure(error, res)) return;
      res.status(503).json({ ok: false, code: "OTP_DELIVERY_FAILED", message: "The verification code could not be sent. Please try again shortly." });
    }
    return;
  }

  // Legacy email verification remains available during migration.
  const body = parseBody(z.object({ email: emailSchema }), req, res);
  if (!body) return;
  const user = (await query<{ id: string; email: string; verified: boolean }>(
    "SELECT id, email, verified FROM users WHERE LOWER(email) = $1 AND deleted_at IS NULL LIMIT 1",
    [body.email]
  )).rows[0];
  if (!user || user.verified) {
    res.json({ ok: true, message: "If the account is eligible, a verification code was sent." });
    return;
  }
  const code = await issueLegacyEmailCode(user.email, true);
  if (!code) {
    res.status(429).json({ ok: false, message: "Please wait before requesting another code." });
    return;
  }
  await sendVerificationEmail(user.email, code);
  res.json({ ok: true, message: "Verification code resent." });
});

router.post("/login", loginLimiter, async (req: Request, res: Response) => {
  const body = parseBody(
    z.object({ identifier: z.string().trim().min(3).max(254).optional(), email: emailSchema.optional(), password: z.string().min(1).max(128) })
      .refine((value) => !!value.identifier || !!value.email, "Phone number or email is required"),
    req,
    res
  );
  if (!body) return;
  const supplied = body.identifier || body.email || "";
  const isEmail = supplied.includes("@");
  let normalized = supplied.trim().toLowerCase();
  if (!isEmail) {
    try {
      normalized = normalizeNigerianPhone(supplied);
    } catch {
      res.status(401).json({ ok: false, message: "Invalid login credentials" });
      return;
    }
  }

  const result = await query<{
    id: string; first_name: string | null; last_name: string | null; email: string | null;
    phone_e164: string | null; role: string; verified: boolean; phone_verified_at: Date | null; password_hash: string | null;
  }>(
    `SELECT id, first_name, last_name, email, phone_e164, role, verified, phone_verified_at, password_hash
     FROM users
     WHERE ${isEmail ? "LOWER(email) = $1" : "phone_e164 = $1"}
       AND deleted_at IS NULL AND deletion_requested_at IS NULL
     LIMIT 1`,
    [normalized]
  );
  const user = result.rows[0];
  if (!user?.password_hash || (!isEmail && PRIVILEGED_ROLES.has(user.role))) {
    res.status(401).json({ ok: false, message: "Invalid login credentials" });
    return;
  }
  if (isEmail && !PRIVILEGED_ROLES.has(user.role) && !env.ALLOW_LEGACY_PUBLIC_EMAIL_LOGIN) {
    res.status(403).json({ ok: false, code: "PHONE_LOGIN_REQUIRED", message: "Please sign in with your verified phone number." });
    return;
  }
  const password = await verifyPassword(body.password, user.password_hash);
  if (!password.valid) {
    res.status(401).json({ ok: false, message: "Invalid login credentials" });
    return;
  }
  if (!user.verified || (!isEmail && !user.phone_verified_at)) {
    if (!PRIVILEGED_ROLES.has(user.role) && user.phone_e164 && env.PHONE_AUTH_ENABLED) {
      try {
        const challenge = await createChallenge({
          userId: user.id,
          purpose: "signup",
          phoneE164: user.phone_e164,
          req,
        });
        res.status(403).json({
          ok: false,
          code: "PHONE_VERIFICATION_REQUIRED",
          message: "Please verify your phone number before logging in.",
          maskedPhone: maskPhone(user.phone_e164),
          ...challenge,
        });
        return;
      } catch (error) {
        req.log.warn({ err: error, userId: user.id }, "Login verification OTP delivery failed");
      }
    }
    res.status(403).json({ ok: false, code: "PHONE_VERIFICATION_REQUIRED", message: "Please verify your phone number before logging in." });
    return;
  }
  if (password.needsRehash) {
    await query("UPDATE users SET password_hash = $1, password_updated_at = NOW() WHERE id = $2", [await hashPassword(body.password), user.id]);
  }
  const tokens = await createSessionTokens(user.id, req);
  res.json({
    ok: true,
    message: "Login success",
    userId: user.id,
    firstName: user.first_name ?? undefined,
    lastName: user.last_name ?? undefined,
    email: user.email ?? undefined,
    phone: user.phone_e164 ?? undefined,
    phoneVerified: !!user.phone_verified_at,
    role: user.role,
    token: tokens.accessToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    phoneMigrationRequired: isEmail && !PRIVILEGED_ROLES.has(user.role) && !user.phone_verified_at,
  });
});

router.post("/refresh", loginLimiter, async (req: Request, res: Response) => {
  const body = parseBody(z.object({ refreshToken: z.string().min(20).max(512) }), req, res);
  if (!body) return;
  const tokens = await rotateRefreshToken(body.refreshToken, req);
  if (!tokens) {
    res.status(401).json({ ok: false, message: "Invalid or expired refresh token" });
    return;
  }
  res.json({ ok: true, token: tokens.accessToken, ...tokens });
});

router.post("/logout", async (req: Request, res: Response) => {
  const user = await authenticateRequest(req);
  const refreshToken = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : undefined;
  await Promise.all([revokeSession(user?.sessionId), revokeRefreshToken(refreshToken)]);
  res.status(204).send();
});

router.post("/forgot-password", messageLimiter, async (req: Request, res: Response) => {
  const body = parseBody(z.object({ identifier: z.string().trim().min(3).max(254).optional(), phone: z.string().trim().optional(), email: emailSchema.optional() }), req, res);
  if (!body) return;
  const supplied = body.identifier || body.phone || body.email || "";
  const genericMessage = "If an eligible account exists, password reset instructions were sent.";

  if (supplied.includes("@")) {
    const normalizedEmail = supplied.toLowerCase();
    const user = (await query<{ id: string; email: string; role: string }>(
      "SELECT id, email, role FROM users WHERE LOWER(email) = $1 AND deleted_at IS NULL AND deletion_requested_at IS NULL LIMIT 1",
      [normalizedEmail]
    )).rows[0];
    if (user && (PRIVILEGED_ROLES.has(user.role) || env.ALLOW_LEGACY_PUBLIC_EMAIL_LOGIN)) {
      await sendLegacyPasswordReset(user.email);
    }
    res.json({ ok: true, message: genericMessage, channel: "email" });
    return;
  }

  if (!ensurePhoneAuth(res)) return;
  let phoneE164: string;
  try {
    phoneE164 = normalizeNigerianPhone(supplied);
  } catch {
    res.json({ ok: true, message: genericMessage, channel: "sms", smsAvailableIn: 60 });
    return;
  }
  const user = (await query<{ id: string }>(
    `SELECT id FROM users
     WHERE phone_e164 = $1 AND phone_verified_at IS NOT NULL
       AND role NOT IN ('admin', 'staff') AND deleted_at IS NULL AND deletion_requested_at IS NULL
     LIMIT 1`,
    [phoneE164]
  )).rows[0];
  try {
    const challenge = await createChallenge({ userId: user?.id || null, purpose: "password_reset", phoneE164, req, send: !!user });
    res.json({ ok: true, message: genericMessage, maskedPhone: maskPhone(phoneE164), ...challenge });
  } catch (error) {
    if (challengeFailure(error, res)) return;
    res.status(503).json({ ok: false, code: "OTP_DELIVERY_FAILED", message: "Password recovery is temporarily unavailable." });
  }
});

router.post("/verify-reset-code", loginLimiter, async (req: Request, res: Response) => {
  const body = parseBody(z.object({ challengeId: z.string().min(10).max(100), code: z.string().regex(/^\d{6}$/) }), req, res);
  if (!body) return;
  try {
    const result = await verifyChallenge({ challengeId: body.challengeId, code: body.code, expectedPurpose: "password_reset" });
    res.json({ ok: true, resetToken: result.resetToken, expiresIn: 600 });
  } catch (error) {
    if (challengeFailure(error, res)) return;
    throw error;
  }
});

router.post("/reset-password", loginLimiter, async (req: Request, res: Response) => {
  const phoneReset = z.object({ resetToken: z.string().min(32).max(256), newPassword: passwordSchema }).safeParse(req.body);
  if (phoneReset.success) {
    const tokenHash = resetTokenHash(phoneReset.data.resetToken);
    const client = await pool.connect();
    let userId: string | undefined;
    try {
      await client.query("BEGIN");
      const challenge = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM auth_challenges
         WHERE reset_token_hash = $1 AND reset_token_expires_at > NOW() AND user_id IS NOT NULL
         FOR UPDATE`,
        [tokenHash]
      );
      const row = challenge.rows[0];
      if (!row) throw new ChallengeError(400, "RESET_TOKEN_INVALID", "Invalid or expired reset token.");
      userId = row.user_id;
      await client.query(
        `UPDATE users SET password_hash = $1, password_updated_at = NOW(), token_version = token_version + 1
         WHERE id = $2 AND deleted_at IS NULL`,
        [await hashPassword(phoneReset.data.newPassword), userId]
      );
      await client.query("UPDATE auth_challenges SET reset_token_hash = NULL, reset_token_expires_at = NULL, updated_at = NOW() WHERE id = $1", [row.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (challengeFailure(error, res)) return;
      throw error;
    } finally {
      client.release();
    }
    await revokeAllUserSessions(userId);
    res.json({ ok: true, message: "Password reset successful. Please log in again." });
    return;
  }

  const body = parseBody(z.object({ email: emailSchema, token: z.string().min(32).max(256), newPassword: passwordSchema }), req, res);
  if (!body) return;
  const suppliedHash = hashOpaqueToken(body.token.trim());
  const client = await pool.connect();
  let userId: string | undefined;
  try {
    await client.query("BEGIN");
    const token = (await client.query<{ token_hash: string }>(
      "SELECT token_hash FROM password_reset_tokens WHERE email = $1 AND expires_at > NOW() FOR UPDATE",
      [body.email]
    )).rows[0];
    if (!token || !secureEqual(token.token_hash, suppliedHash)) throw new ChallengeError(400, "RESET_TOKEN_INVALID", "Invalid or expired reset token.");
    userId = (await client.query<{ id: string }>(
      `UPDATE users SET password_hash = $1, password_updated_at = NOW(), token_version = token_version + 1
       WHERE LOWER(email) = $2 AND deleted_at IS NULL RETURNING id`,
      [await hashPassword(body.newPassword), body.email]
    )).rows[0]?.id;
    if (!userId) throw new ChallengeError(400, "RESET_TOKEN_INVALID", "Invalid or expired reset token.");
    await client.query("DELETE FROM password_reset_tokens WHERE email = $1", [body.email]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (challengeFailure(error, res)) return;
    throw error;
  } finally {
    client.release();
  }
  await revokeAllUserSessions(userId);
  res.json({ ok: true, message: "Password reset successful. Please log in again." });
});

router.post("/phone-change/request", requireAuthenticated, messageLimiter, async (req: Request, res: Response) => {
  if (!ensurePhoneAuth(res) || !req.user) return;
  const body = parseBody(z.object({ phone: z.string().trim().min(7).max(30), currentPassword: z.string().min(1).max(128) }), req, res);
  if (!body) return;
  let phoneE164: string;
  try {
    phoneE164 = normalizeNigerianPhone(body.phone);
  } catch (error) {
    if (challengeFailure(error, res)) return;
    throw error;
  }
  const user = (await query<{ id: string; password_hash: string | null; phone_verified_at: Date | null }>(
    "SELECT id, password_hash, phone_verified_at FROM users WHERE id = $1 AND deleted_at IS NULL",
    [req.user.id]
  )).rows[0];
  if (!user?.password_hash || !(await verifyPassword(body.currentPassword, user.password_hash)).valid) {
    res.status(401).json({ ok: false, message: "Current password is incorrect." });
    return;
  }
  const duplicate = await query("SELECT 1 FROM users WHERE phone_e164 = $1 AND id <> $2 AND deleted_at IS NULL LIMIT 1", [phoneE164, user.id]);
  if (duplicate.rowCount) {
    res.status(409).json({ ok: false, code: "PHONE_IN_USE", message: "That phone number is already in use." });
    return;
  }
  try {
    const challenge = await createChallenge({
      userId: user.id,
      purpose: user.phone_verified_at ? "phone_change" : "phone_migration",
      phoneE164,
      req,
      metadata: {
        smsSecurityConsent: true,
        updateWhatsappTransactionConsent: true,
      },
    });
    res.json({ ok: true, message: "Verification code sent by SMS.", maskedPhone: maskPhone(phoneE164), ...challenge });
  } catch (error) {
    if (challengeFailure(error, res)) return;
    res.status(503).json({ ok: false, code: "OTP_DELIVERY_FAILED", message: "The verification code could not be sent." });
  }
});

router.post("/phone-change/verify", requireAuthenticated, loginLimiter, async (req: Request, res: Response) => {
  if (!req.user) return;
  const body = parseBody(z.object({ challengeId: z.string().min(10).max(100), code: z.string().regex(/^\d{6}$/) }), req, res);
  if (!body) return;
  try {
    const result = await verifyChallenge({
      challengeId: body.challengeId,
      code: body.code,
      expectedPurpose: ["phone_change", "phone_migration"],
      expectedUserId: req.user.id,
    });
    await revokeAllUserSessions(req.user.id);
    res.json({ ok: true, message: "Phone number updated. Please log in again.", phone: result.phoneE164 });
  } catch (error) {
    if (challengeFailure(error, res)) return;
    throw error;
  }
});

router.patch("/messaging-consent", requireAuthenticated, async (req: Request, res: Response) => {
  if (!req.user) return;
  const body = parseBody(z.object({ whatsappTransactionConsent: z.boolean() }), req, res);
  if (!body) return;
  const result = await query(
    `UPDATE users
     SET whatsapp_transaction_consent_at = CASE WHEN $2 THEN NOW() ELSE NULL END
     WHERE id = $1 AND phone_verified_at IS NOT NULL AND deleted_at IS NULL`,
    [req.user.id, body.whatsappTransactionConsent]
  );
  if (!result.rowCount) {
    res.status(409).json({ ok: false, message: "Verify a phone number before changing WhatsApp preferences." });
    return;
  }
  res.json({ ok: true, whatsappTransactionConsent: body.whatsappTransactionConsent });
});

// Legacy email verification is intentionally retained for existing accounts and privileged users.
function legacyVerificationHash(email: string, code: string): string {
  const secret = env.AUTH_TOKEN_SECRET || "quickserve-development-verification-secret";
  return createHmac("sha256", secret).update(`${email}:${code}`).digest("hex");
}

async function issueLegacyEmailCode(email: string, enforceCooldown: boolean): Promise<string | null> {
  const code = randomInt(100_000, 1_000_000).toString();
  const result = await query(
    `INSERT INTO verification_codes (email, code, code_hash, expires_at, attempt_count, last_sent_at, created_at)
     VALUES ($1, NULL, $2, NOW() + INTERVAL '10 minutes', 0, NOW(), NOW())
     ON CONFLICT (email) DO UPDATE SET code = NULL, code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at, attempt_count = 0, last_sent_at = NOW()
     ${enforceCooldown ? "WHERE verification_codes.last_sent_at < NOW() - INTERVAL '60 seconds'" : ""}`,
    [email, legacyVerificationHash(email, code)]
  );
  return result.rowCount ? code : null;
}

async function sendVerificationEmail(email: string, code: string): Promise<void> {
  await sendTransactionalEmail({
    to: email,
    subject: "Your QuickServe verification code",
    text: `Your QuickServe verification code is ${code}. It expires in 10 minutes. Never share this code with anyone.`,
    template: "email-verification",
  });
}

async function sendLegacyPasswordReset(email: string): Promise<void> {
  const rawToken = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
  await query(
    `INSERT INTO password_reset_tokens (email, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '15 minutes')
     ON CONFLICT (email) DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, created_at = NOW()`,
    [email, hashOpaqueToken(rawToken)]
  );
  const resetLink = `${env.APP_DEEP_LINK_SCHEME}://reset-password?email=${encodeURIComponent(email)}&token=${encodeURIComponent(rawToken)}`;
  await sendTransactionalEmail({
    to: email,
    subject: "Reset your QuickServe password",
    text: `Open this link to reset your QuickServe password: ${resetLink}\n\nThis one-time link expires in 15 minutes.`,
    template: "password-reset",
  });
}

async function handleVerifyEmail(req: Request, res: Response): Promise<void> {
  const body = parseBody(z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }), req, res);
  if (!body) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = (await client.query<{ id: string; verified: boolean }>(
      "SELECT id, verified FROM users WHERE LOWER(email) = $1 AND deleted_at IS NULL FOR UPDATE",
      [body.email]
    )).rows[0];
    if (!user) throw new ChallengeError(400, "EMAIL_CODE_INVALID", "Invalid or expired verification code.");
    if (user.verified) {
      await client.query("DELETE FROM verification_codes WHERE email = $1", [body.email]);
      await client.query("COMMIT");
      res.status(409).json({ ok: false, message: "This account is already verified. Please log in." });
      return;
    }
    const codeRow = (await client.query<{ code_hash: string | null }>(
      `UPDATE verification_codes SET attempt_count = attempt_count + 1
       WHERE email = $1 AND expires_at > NOW() AND attempt_count < 5 RETURNING code_hash`,
      [body.email]
    )).rows[0];
    if (!codeRow?.code_hash || !secureEqual(codeRow.code_hash, legacyVerificationHash(body.email, body.code))) {
      await client.query("COMMIT");
      res.status(400).json({ ok: false, message: "Invalid or expired verification code." });
      return;
    }
    await client.query("UPDATE users SET verified = TRUE WHERE id = $1", [user.id]);
    await client.query("DELETE FROM verification_codes WHERE email = $1", [body.email]);
    await client.query("COMMIT");
    res.json({ ok: true, message: "Email verified successfully. Your account is active.", email: body.email });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (challengeFailure(error, res)) return;
    throw error;
  } finally {
    client.release();
  }
}

router.post("/verify", loginLimiter, handleVerifyEmail);
router.post("/verify-email", loginLimiter, handleVerifyEmail);

export default router;
