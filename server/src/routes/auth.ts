import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "crypto";
import { Request, Response, Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { env } from "../config/env";
import { pool, query } from "../db";
import {
  authenticateRequest,
  createSessionTokens,
  revokeAllUserSessions,
  revokeRefreshToken,
  revokeSession,
  rotateRefreshToken,
} from "../middleware/auth";
import { sendTransactionalEmail } from "../services/email";
import { hashPassword, verifyPassword } from "../services/passwords";

const router = Router();

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

const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.isProduction ? 8 : 500,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { ok: false, message: "Too many email requests. Please try again later." },
});

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password is too long");
const signupSchema = z.object({
  role: z.enum(["mechanic", "vendor", "dispatcher", "user"]),
  email: emailSchema,
  password: passwordSchema,
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  fullName: z.string().trim().max(160).optional(),
  phone: z.string().trim().max(30).optional(),
});

function parseBody<T>(
  schema: z.ZodType<T>,
  req: Request,
  res: Response
): T | undefined {
  const parsed = schema.safeParse(req.body);
  if (parsed.success) return parsed.data;
  res.status(400).json({
    ok: false,
    message: parsed.error.issues[0]?.message || "Invalid request",
  });
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

function verificationCodeHash(email: string, code: string): string {
  const secret = env.AUTH_TOKEN_SECRET || "quickserve-development-verification-secret";
  return createHmac("sha256", secret).update(`${email}:${code}`).digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function issueVerificationCode(email: string, enforceCooldown: boolean): Promise<string | null> {
  const code = randomInt(100_000, 1_000_000).toString();
  const codeHash = verificationCodeHash(email, code);
  const result = await query(
    `INSERT INTO verification_codes
       (email, code, code_hash, expires_at, attempt_count, last_sent_at, created_at)
     VALUES ($1, NULL, $2, NOW() + INTERVAL '10 minutes', 0, NOW(), NOW())
     ON CONFLICT (email) DO UPDATE
       SET code = NULL,
           code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at,
           attempt_count = 0,
           last_sent_at = NOW()
     ${enforceCooldown ? "WHERE verification_codes.last_sent_at < NOW() - INTERVAL '60 seconds'" : ""}`,
    [email, codeHash]
  );
  return result.rowCount > 0 ? code : null;
}

async function sendVerificationEmail(email: string, code: string): Promise<void> {
  await sendTransactionalEmail({
    to: email,
    subject: "Your QuickServe verification code",
    text: `Your QuickServe verification code is ${code}. It expires in 10 minutes. Never share this code with anyone.`,
    template: "email-verification",
  });
}

async function releaseVerificationCooldown(email: string): Promise<void> {
  await query(
    "UPDATE verification_codes SET last_sent_at = NOW() - INTERVAL '61 seconds' WHERE email = $1",
    [email.toLowerCase()]
  );
}

async function sendWelcomeEmail(email: string, firstName: string | null): Promise<void> {
  await sendTransactionalEmail({
    to: email,
    subject: "Welcome to QuickServe",
    text: [
      firstName ? `Hi ${firstName},` : "Hi there,",
      "",
      "Your email is verified and your QuickServe account is active.",
      "",
      "If you did not create this account, contact QuickServe support immediately.",
    ].join("\n"),
    template: "welcome",
  });
}

router.post("/signup", emailLimiter, async (req: Request, res: Response) => {
  const body = parseBody(signupSchema, req, res);
  if (!body) return;

  const legacyName = splitLegacyName(body.fullName);
  const firstName = normalizeName(body.firstName) ?? legacyName.firstName;
  const lastName = normalizeName(body.lastName) ?? legacyName.lastName;
  const userId = identifier("usr");
  const passwordHash = await hashPassword(body.password);

  try {
    await query(
      `INSERT INTO users
         (id, first_name, last_name, phone, email, password_hash, role, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)`,
      [userId, firstName, lastName, body.phone || null, body.email, passwordHash, body.role]
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      const existing = await query<{ verified: boolean }>(
        "SELECT verified FROM users WHERE LOWER(email) = $1 LIMIT 1",
        [body.email]
      );
      res.status(409).json({
        ok: false,
        code: existing.rows[0]?.verified ? "ACCOUNT_EXISTS" : "ACCOUNT_UNVERIFIED",
        message: existing.rows[0]?.verified
          ? "Account already exists. Please log in."
          : "Account already exists but is not verified. Request a new verification code.",
      });
      return;
    }
    throw error;
  }

  const code = await issueVerificationCode(body.email, false);
  if (!code) throw new Error("Could not create verification code");
  try {
    await sendVerificationEmail(body.email, code);
  } catch (error) {
    await releaseVerificationCooldown(body.email).catch(() => undefined);
    req.log.error({ err: error, userId }, "Verification email delivery failed");
    res.status(503).json({
      ok: false,
      code: "EMAIL_DELIVERY_FAILED",
      message: "Your account was created, but the verification email could not be sent. Try resend shortly.",
    });
    return;
  }

  req.log.info({ userId, role: body.role }, "User account created");
  res.status(201).json({
    ok: true,
    message: "Account created. Verification code sent.",
    role: body.role,
    email: body.email,
  });
});

router.post("/resend-code", emailLimiter, async (req: Request, res: Response) => {
  const body = parseBody(z.object({ email: emailSchema }), req, res);
  if (!body) return;

  const userResult = await query<{ id: string; email: string; verified: boolean }>(
    "SELECT id, email, verified FROM users WHERE LOWER(email) = $1 AND deleted_at IS NULL LIMIT 1",
    [body.email]
  );
  const user = userResult.rows[0];
  if (!user) {
    res.json({ ok: true, message: "If the account is eligible, a verification code was sent." });
    return;
  }
  if (user.verified) {
    res.status(409).json({ ok: false, code: "ACCOUNT_ALREADY_VERIFIED", message: "This account is already verified. Please log in." });
    return;
  }

  const code = await issueVerificationCode(user.email.toLowerCase(), true);
  if (!code) {
    res.status(429).json({ ok: false, message: "Please wait before requesting another code." });
    return;
  }
  try {
    await sendVerificationEmail(user.email, code);
  } catch (error) {
    await releaseVerificationCooldown(user.email).catch(() => undefined);
    req.log.error({ err: error, userId: user.id }, "Verification email resend failed");
    res.status(503).json({
      ok: false,
      code: "EMAIL_DELIVERY_FAILED",
      message: "The verification email could not be sent. Please try again shortly.",
    });
    return;
  }
  res.json({ ok: true, message: "Verification code resent." });
});

router.post("/login", loginLimiter, async (req: Request, res: Response) => {
  const body = parseBody(
    z.object({ email: emailSchema, password: z.string().min(1).max(128) }),
    req,
    res
  );
  if (!body) return;

  const result = await query<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string;
    role: string;
    verified: boolean;
    password_hash: string | null;
  }>(
    `SELECT id, first_name, last_name, email, role, verified, password_hash
     FROM users
     WHERE LOWER(email) = $1 AND deleted_at IS NULL AND deletion_requested_at IS NULL
     LIMIT 1`,
    [body.email]
  );
  const user = result.rows[0];
  if (!user?.password_hash) {
    res.status(401).json({ ok: false, message: "Invalid login credentials" });
    return;
  }

  const password = await verifyPassword(body.password, user.password_hash);
  if (!password.valid) {
    res.status(401).json({ ok: false, message: "Invalid login credentials" });
    return;
  }
  if (!user.verified) {
    res.status(403).json({ ok: false, message: "Please verify your email before logging in" });
    return;
  }

  if (password.needsRehash) {
    await query(
      "UPDATE users SET password_hash = $1, password_updated_at = NOW() WHERE id = $2",
      [await hashPassword(body.password), user.id]
    );
  }

  const tokens = await createSessionTokens(user.id, req);
  req.log.info({ userId: user.id }, "Login successful");
  res.json({
    ok: true,
    message: "Login success",
    userId: user.id,
    firstName: user.first_name ?? undefined,
    lastName: user.last_name ?? undefined,
    email: user.email,
    role: user.role,
    token: tokens.accessToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
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

router.post("/forgot-password", emailLimiter, async (req: Request, res: Response) => {
  const body = parseBody(z.object({ email: emailSchema }), req, res);
  if (!body) return;
  const genericResponse = {
    ok: true,
    message: "If an account with that email exists, password reset instructions were sent.",
  };

  const result = await query<{ id: string; email: string }>(
    "SELECT id, email FROM users WHERE LOWER(email) = $1 AND deleted_at IS NULL AND deletion_requested_at IS NULL LIMIT 1",
    [body.email]
  );
  const user = result.rows[0];
  if (!user) {
    res.json(genericResponse);
    return;
  }

  const rawToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  await query(
    `INSERT INTO password_reset_tokens (email, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '15 minutes')
     ON CONFLICT (email) DO UPDATE
       SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, created_at = NOW()`,
    [body.email, hashOpaqueToken(rawToken)]
  );
  const resetLink = `${env.APP_DEEP_LINK_SCHEME}://reset-password?email=${encodeURIComponent(body.email)}&token=${encodeURIComponent(rawToken)}`;
  await sendTransactionalEmail({
    to: user.email,
    subject: "Reset your QuickServe password",
    text: `Open this link to reset your QuickServe password: ${resetLink}\n\nThis one-time link expires in 15 minutes. If you did not request it, ignore this email.`,
    template: "password-reset",
  });
  res.json(genericResponse);
});

router.post("/reset-password", loginLimiter, async (req: Request, res: Response) => {
  const body = parseBody(
    z.object({ email: emailSchema, token: z.string().min(32).max(256), newPassword: passwordSchema }),
    req,
    res
  );
  if (!body) return;

  const suppliedHash = hashOpaqueToken(body.token.trim());
  const client = await pool.connect();
  let userId: string | undefined;
  try {
    await client.query("BEGIN");
    const tokenResult = await client.query<{ token_hash: string }>(
      `SELECT token_hash FROM password_reset_tokens
       WHERE email = $1 AND expires_at > NOW()
       FOR UPDATE`,
      [body.email]
    );
    const expectedHash = tokenResult.rows[0]?.token_hash;
    if (!expectedHash || !secureEqual(expectedHash, suppliedHash)) {
      await client.query("ROLLBACK");
      res.status(400).json({ ok: false, message: "Invalid or expired reset token" });
      return;
    }

    const update = await client.query<{ id: string }>(
      `UPDATE users
       SET password_hash = $1, password_updated_at = NOW(), token_version = token_version + 1
       WHERE LOWER(email) = $2 AND deleted_at IS NULL
       RETURNING id`,
      [await hashPassword(body.newPassword), body.email]
    );
    userId = update.rows[0]?.id;
    if (!userId) {
      await client.query("ROLLBACK");
      res.status(400).json({ ok: false, message: "Invalid or expired reset token" });
      return;
    }
    await client.query("DELETE FROM password_reset_tokens WHERE email = $1", [body.email]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await revokeAllUserSessions(userId);
  res.json({ ok: true, message: "Password reset successful. Please log in again." });
});

async function handleVerifyEmail(req: Request, res: Response): Promise<void> {
  const body = parseBody(
    z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") }),
    req,
    res
  );
  if (!body) return;

  const client = await pool.connect();
  let user: { id: string; email: string; first_name: string | null; verified: boolean; welcome_email_sent_at: Date | null } | undefined;
  try {
    await client.query("BEGIN");
    const userResult = await client.query<{
      id: string;
      email: string;
      first_name: string | null;
      verified: boolean;
      welcome_email_sent_at: Date | null;
    }>(
      `SELECT id, email, first_name, verified, welcome_email_sent_at
       FROM users WHERE LOWER(email) = $1 AND deleted_at IS NULL FOR UPDATE`,
      [body.email]
    );
    user = userResult.rows[0];
    if (!user) {
      await client.query("ROLLBACK");
      res.status(400).json({ ok: false, message: "Invalid or expired verification code" });
      return;
    }
    if (user.verified) {
      await client.query("DELETE FROM verification_codes WHERE email = $1", [body.email]);
      await client.query("COMMIT");
      res.status(409).json({ ok: false, message: "This account is already verified. Please log in." });
      return;
    }

    const codeResult = await client.query<{ code_hash: string | null; attempt_count: number }>(
      `UPDATE verification_codes
       SET attempt_count = attempt_count + 1
       WHERE email = $1 AND expires_at > NOW() AND attempt_count < 5
       RETURNING code_hash, attempt_count`,
      [body.email]
    );
    const codeRow = codeResult.rows[0];
    const valid = !!codeRow?.code_hash && secureEqual(
      codeRow.code_hash,
      verificationCodeHash(body.email, body.code)
    );
    if (!valid) {
      await client.query("COMMIT");
      res.status(400).json({ ok: false, message: "Invalid or expired verification code" });
      return;
    }

    await client.query("UPDATE users SET verified = TRUE WHERE id = $1", [user.id]);
    await client.query("DELETE FROM verification_codes WHERE email = $1", [body.email]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  let welcomeEmailSent = false;
  if (user && !user.welcome_email_sent_at) {
    try {
      await sendWelcomeEmail(user.email, user.first_name);
      await query(
        "UPDATE users SET welcome_email_sent_at = NOW() WHERE id = $1 AND welcome_email_sent_at IS NULL",
        [user.id]
      );
      welcomeEmailSent = true;
    } catch (error) {
      req.log.warn({ err: error, userId: user.id }, "Welcome email delivery failed");
    }
  }

  res.json({
    ok: true,
    message: "Email verified successfully. Your account is active.",
    email: body.email,
    welcomeEmailSent,
  });
}

router.post("/verify", loginLimiter, handleVerifyEmail);
router.post("/verify-email", loginLimiter, handleVerifyEmail);

export default router;
