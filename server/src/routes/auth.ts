import { Request, Response, Router } from "express";
import nodemailer from "nodemailer";
import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { query } from "../db";

const router = Router();
const scryptAsync = promisify(scrypt);

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const fromEmail =
  process.env.SMTP_FROM || process.env.SMTP_USER || "no-reply@example.com";

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function validatePassword(password: string): string | null {
  if (!password || password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 128) return "Password is too long";
  return null;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, salt, expectedHex] = stored.split(":");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const expected = Buffer.from(expectedHex, "hex");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

router.post("/signup", async (req: Request, res: Response) => {
  const log = req.log;
  const { role, email, password } = req.body as {
    role?: string;
    email?: string;
    password?: string;
  };

  if (!email || !role || !password) {
    log.warn({ email: !!email, role: !!role, password: !!password }, "Signup missing fields");
    return res.status(400).json({
      ok: false,
      message: "Missing required fields: email, role or password",
    });
  }

  const normalizedEmail = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    log.warn({ email: normalizedEmail }, "Signup invalid email format");
    return res.status(400).json({ ok: false, message: "Invalid email format" });
  }

  const normalizedRole = String(role).toLowerCase().trim();
  if (!normalizedRole) {
    return res.status(400).json({ ok: false, message: "Invalid role" });
  }
  const passwordError = validatePassword(password);
  if (passwordError) {
    return res.status(400).json({ ok: false, message: passwordError });
  }

  try {
    const existing = await query<{ id: string }>(
      "SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1",
      [normalizedEmail]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        ok: false,
        message: "Account already exists. Please log in.",
      });
    }
    const userId = genId("usr");
    const passwordHash = await hashPassword(password);
    await query(
      "INSERT INTO users (id, email, password_hash, role, verified) VALUES ($1, $2, $3, $4, FALSE)",
      [userId, normalizedEmail, passwordHash, normalizedRole]
    );
    log.info({ userId, email: normalizedEmail, role: normalizedRole }, "User created");

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await query(
      `INSERT INTO verification_codes (email, code, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = $3`,
      [normalizedEmail, code, expiresAt]
    );

    await transporter.sendMail({
      from: fromEmail,
      to: email,
      subject: "Your SpareParts Hub verification code",
      text: `Your verification code is ${code}. It expires in 10 minutes.`,
    });
    log.info({ email: normalizedEmail }, "Verification email sent");
  } catch (err) {
    log.error({ err, email: normalizedEmail }, "Signup failed");
    if (String(err).includes("nodemailer") || String(err).includes("sendMail")) {
      return res.status(500).json({
        ok: false,
        message: "Could not send verification email",
      });
    }
    throw err;
  }

  return res.status(201).json({
    ok: true,
    message: "Sign up success (placeholder). Verification code generated.",
    role: normalizedRole,
    email: normalizedEmail,
  });
});

router.post("/resend-code", async (req: Request, res: Response) => {
  const log = req.log;
  const { email } = req.body as { email?: string };

  if (!email) {
    return res.status(400).json({ ok: false, message: "Email is required" });
  }

  const normalized = email.toLowerCase();
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  try {
    await query(
      `INSERT INTO verification_codes (email, code, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = $3`,
      [normalized, code, expiresAt]
    );
    await transporter.sendMail({
      from: fromEmail,
      to: email,
      subject: "Your SpareParts Hub verification code",
      text: `Your new verification code is ${code}. It expires in 10 minutes.`,
    });
    log.info({ email: normalized }, "Verification code resent");
  } catch (err) {
    log.error({ err, email: normalized }, "Resend verification email failed");
    return res.status(500).json({
      ok: false,
      message: "Could not resend verification email",
    });
  }

  return res.json({
    ok: true,
    message: "Verification code resent (placeholder).",
  });
});

router.post("/login", async (req: Request, res: Response) => {
  const log = req.log;
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: "Email and password are required" });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const { rows } = await query<{
    id: string;
    email: string;
    role: string;
    verified: boolean;
    password_hash: string | null;
  }>(
    "SELECT id, email, role, verified, password_hash FROM users WHERE LOWER(email) = $1",
    [normalizedEmail]
  );
  const user = rows[0];

  if (!user || !user.password_hash) {
    log.warn({ email: normalizedEmail }, "Login failed: user not found");
    return res
      .status(401)
      .json({ ok: false, message: "Invalid login credentials" });
  }

  const isPasswordValid = await verifyPassword(password, user.password_hash);
  if (!isPasswordValid) {
    log.warn({ email: normalizedEmail }, "Login failed: wrong password");
    return res
      .status(401)
      .json({ ok: false, message: "Invalid login credentials" });
  }

  if (!user.verified) {
    return res.status(403).json({
      ok: false,
      message: "Please verify your email before logging in",
    });
  }

  const tokenPayload = `${user.id}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
  const token = Buffer.from(tokenPayload).toString("base64url");
  log.info({ userId: user.id, email: user.email }, "Login success");

  return res.json({
    ok: true,
    message: "Login success",
    userId: user.id,
    email: user.email,
    role: user.role,
    token,
  });
});

async function handleVerifyEmail(req: Request, res: Response) {
  const log = req.log;
  const { email, code } = req.body as { email?: string; code?: string };

  if (!email || !code) {
    return res
      .status(400)
      .json({ ok: false, message: "Email and code are required" });
  }

  const normalized = email.toLowerCase();
  const { rows: codeRows } = await query<{ code: string }>(
    "SELECT code FROM verification_codes WHERE email = $1 AND expires_at > NOW()",
    [normalized]
  );
  const expected = codeRows[0]?.code;

  if (!expected || expected !== code) {
    log.warn({ email: normalized }, "Verify failed: invalid or expired code");
    return res
      .status(400)
      .json({ ok: false, message: "Invalid or expired verification code" });
  }

  await query("DELETE FROM verification_codes WHERE email = $1", [normalized]);
  await query("UPDATE users SET verified = TRUE WHERE LOWER(email) = $1", [normalized]);
  log.info({ email: normalized }, "Email verified");

  return res.json({
    ok: true,
    message: "Email verified successfully (placeholder).",
    email: normalized,
  });
}

router.post("/verify", handleVerifyEmail);
router.post("/verify-email", handleVerifyEmail);

export default router;
