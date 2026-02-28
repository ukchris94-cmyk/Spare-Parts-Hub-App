import { Request, Response, Router } from "express";
import nodemailer from "nodemailer";
import { query } from "../db";

const router = Router();

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

router.post("/signup", async (req: Request, res: Response) => {
  const log = req.log;
  const { role, email } = req.body as { role?: string; email?: string };

  if (!email || !role) {
    log.warn({ email: !!email, role: !!role }, "Signup missing fields");
    return res.status(400).json({
      ok: false,
      message: "Missing required fields: email or role",
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

  try {
    const existing = await query<{ id: string }>(
      "SELECT id FROM users WHERE LOWER(email) = $1",
      [normalizedEmail]
    );
    if (existing.rows.length === 0) {
      const userId = genId("usr");
      await query(
        "INSERT INTO users (id, email, role, verified) VALUES ($1, $2, $3, FALSE)",
        [userId, normalizedEmail, normalizedRole]
      );
      log.info({ userId, email: normalizedEmail, role: normalizedRole }, "User created");
    }

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
  const { email } = req.body as { email?: string };

  if (!email) {
    return res.status(400).json({ ok: false, message: "Email is required" });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const { rows } = await query<{ id: string; email: string; role: string }>(
    "SELECT id, email, role FROM users WHERE LOWER(email) = $1",
    [normalizedEmail]
  );
  const user = rows[0];

  if (!user) {
    log.warn({ email: normalizedEmail }, "Login failed: user not found");
    return res
      .status(401)
      .json({ ok: false, message: "Invalid login credentials" });
  }

  const tokenPayload = `${user.id}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
  const token = Buffer.from(tokenPayload).toString("base64url");
  log.info({ userId: user.id, email: user.email }, "Login success");

  return res.json({
    ok: true,
    message: "Login success",
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
