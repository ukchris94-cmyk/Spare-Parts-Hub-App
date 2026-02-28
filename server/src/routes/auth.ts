import { Request, Response, Router } from "express";
import nodemailer from "nodemailer";
const dotenv = require('dotenv');
dotenv.config();
const router = Router();

// Very simple in-memory storage for demo purposes only.
// In a real app you would persist this in your database with an expiry time.
const verificationCodes = new Map<string, string>();

type UserRecord = {
  id: string;
  email: string;
  role: string;
  verified: boolean;
  createdAt: string;
};

// Simple in-memory "users" table keyed by normalized email.
const users = new Map<string, UserRecord>();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const fromEmail =
  process.env.SMTP_FROM || process.env.SMTP_USER || "no-reply@example.com";

router.post("/signup", async (req, res) => {
  const { role, email } = req.body as { role?: string; email?: string };

  if (!email || !role) {
    return res.status(400).json({
      ok: false,
      message: "Missing required fields: email or role",
    });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Basic payload validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({
      ok: false,
      message: "Invalid email format",
    });
  }

  const normalizedRole = String(role).toLowerCase().trim();
  if (!normalizedRole) {
    return res.status(400).json({
      ok: false,
      message: "Invalid role",
    });
  }

  // "Create" user record in our in-memory store if it does not already exist.
  if (!users.has(normalizedEmail)) {
    const user: UserRecord = {
      id: `usr_${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      email: normalizedEmail,
      role: normalizedRole,
      verified: false,
      createdAt: new Date().toISOString(),
    };
    users.set(normalizedEmail, user);
  }

  // Generate a 6-digit numeric code and store it in memory.
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  verificationCodes.set(email.toLowerCase(), code);

  try {
    await transporter.sendMail({
      from: fromEmail,
      to: email,
      subject: "Your SpareParts Hub verification code",
      text: `Your verification code is ${code}. It expires in 10 minutes.`,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to send signup verification email", err);
    return res.status(500).json({
      ok: false,
      message: "Could not send verification email",
    });
  }

  return res.status(201).json({
    ok: true,
    message: "Sign up success (placeholder). Verification code generated.",
    role,
    email,
  });
});

router.post("/resend-code", async (req, res) => {
  const { email } = req.body as { email?: string };

  if (!email) {
    return res.status(400).json({ ok: false, message: "Email is required" });
  }

  const normalized = email.toLowerCase();
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  verificationCodes.set(normalized, code);

  try {
    await transporter.sendMail({
      from: fromEmail,
      to: email,
      subject: "Your SpareParts Hub verification code",
      text: `Your new verification code is ${code}. It expires in 10 minutes.`,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to resend verification email", err);
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

router.post("/login", (req, res) => {
  const { email } = req.body as { email?: string };

  if (!email) {
    return res.status(400).json({ ok: false, message: "Email is required" });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const user = users.get(normalizedEmail);

  if (!user) {
    return res
      .status(401)
      .json({ ok: false, message: "Invalid login credentials" });
  }

  const tokenPayload = `${user.id}:${Date.now().toString(36)}:${Math.random()
    .toString(36)
    .slice(2)}`;
  const token = Buffer.from(tokenPayload).toString("base64url");

  return res.json({
    ok: true,
    message: "Login success",
    email: user.email,
    role: user.role,
    token,
  });
});

function handleVerifyEmail(req: Request, res: Response) {
  const { email, code } = req.body;

  if (!email || !code) {
    return res
      .status(400)
      .json({ ok: false, message: "Email and code are required" });
  }

  const normalized = email.toLowerCase();
  const expected = verificationCodes.get(normalized);

  if (!expected || expected !== code) {
    return res
      .status(400)
      .json({ ok: false, message: "Invalid or expired verification code" });
  }

  verificationCodes.delete(normalized);

  const user = users.get(normalized);
  if (user && !user.verified) {
    user.verified = true;
    users.set(normalized, user);
  }
  return res.json({
    ok: true,
    message: "Email verified successfully (placeholder).",
    email,
  });
}

// App calls POST /api/auth/verify; keep /verify-email for backwards compatibility
router.post("/verify", handleVerifyEmail);
router.post("/verify-email", handleVerifyEmail);

export default router;
