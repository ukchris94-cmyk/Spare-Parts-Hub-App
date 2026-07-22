import { Request, Response, Router } from "express";
import nodemailer from "nodemailer";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { query } from "../db";
import { createAuthToken } from "../middleware/auth";

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

function isValidRole(role: string): boolean {
  return ["mechanic", "vendor", "dispatcher", "user"].includes(role);
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

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isDbColumnError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: string }).code === "42703"
  );
}

function isUniqueViolationError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

function normalizeFirstName(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  if (!firstToken) return null;
  return firstToken;
}

async function ensureWelcomeEmailColumn(): Promise<void> {
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_email_sent_at TIMESTAMPTZ");
}

type VerificationUserRow = {
  id: string;
  email: string;
  first_name: string | null;
  verified: boolean;
  welcome_email_sent_at: string | null;
};

async function loadVerificationUser(normalizedEmail: string): Promise<VerificationUserRow | null> {
  try {
    const { rows } = await query<VerificationUserRow>(
      `SELECT id, email, first_name, verified, welcome_email_sent_at
       FROM users
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [normalizedEmail]
    );
    return rows[0] ?? null;
  } catch (err) {
    if (!isDbColumnError(err)) throw err;
    await ensureWelcomeEmailColumn();
    const { rows } = await query<VerificationUserRow>(
      `SELECT id, email, first_name, verified, welcome_email_sent_at
       FROM users
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [normalizedEmail]
    );
    return rows[0] ?? null;
  }
}

async function sendWelcomeEmailAfterVerification(params: {
  userId: string;
  email: string;
  firstName: string | null;
  log: Request["log"];
}): Promise<boolean> {
  const { userId, email, firstName, log } = params;
  const greeting = firstName ? `Hi ${firstName},` : "Hi there,";

  await transporter.sendMail({
    from: fromEmail,
    to: email,
    subject: "Welcome to Spare Parts Hub",
    text: [
      greeting,
      "",
      "Welcome to Spare Parts Hub. Your email has been verified and your account is active.",
      "",
      "You can now browse available parts, connect with vendors, track orders, and manage your spare-parts workflow based on your account type.",
      "",
      "Next steps:",
      "- Complete your profile in the app.",
      "- Browse parts or manage your shop workflow based on your account type.",
      "- Use the Help/FAQs area in the app if you need support.",
      "",
      "If you did not create this account, contact support through the app.",
    ].join("\n"),
  });

  try {
    await ensureWelcomeEmailColumn();
    await query(
      "UPDATE users SET welcome_email_sent_at = NOW() WHERE id = $1 AND welcome_email_sent_at IS NULL",
      [userId]
    );
  } catch (err) {
    log.warn({ err, userId }, "Welcome email sent but timestamp update failed");
  }

  return true;
}

router.post("/signup", async (req: Request, res: Response) => {
  const log = req.log;
  const { role, email, password, firstName, fullName, phone } = req.body as {
    role?: string;
    email?: string;
    password?: string;
    firstName?: string;
    lastName?: string;
    fullName?: string;
    phone?: string;
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
  if (!normalizedRole || !isValidRole(normalizedRole)) {
    return res.status(400).json({ ok: false, message: "Invalid role" });
  }
  const normalizedFirstName =
    normalizeFirstName(firstName) ?? normalizeFirstName(fullName);
  const normalizedLastName =
    typeof req.body?.lastName === "string" && req.body.lastName.trim()
      ? req.body.lastName.trim()
      : typeof fullName === "string" && fullName.trim().includes(" ")
        ? fullName.trim().replace(/^\S+\s+/, "").trim() || null
        : null;
  const normalizedPhone = typeof phone === "string" && phone.trim() ? phone.trim() : null;
  const passwordError = validatePassword(password);
  if (passwordError) {
    return res.status(400).json({ ok: false, message: passwordError });
  }

  try {
    const existing = await query<{ id: string; verified: boolean }>(
      "SELECT id, verified FROM users WHERE LOWER(email) = $1 LIMIT 1",
      [normalizedEmail]
    );
    const existingUser = existing.rows[0];
    if (existingUser) {
      return res.status(409).json({
        ok: false,
        code: existingUser.verified ? "ACCOUNT_EXISTS" : "ACCOUNT_UNVERIFIED",
        message: existingUser.verified
          ? "Account already exists. Please log in."
          : "Account already exists but is not verified. Please log in and tap Verify now to resend a code.",
      });
    }
    const userId = genId("usr");
    const passwordHash = await hashPassword(password);
    try {
      await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT");
      await query(
        "INSERT INTO users (id, first_name, last_name, phone, email, password_hash, role, verified) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)",
        [
          userId,
          normalizedFirstName,
          normalizedLastName,
          normalizedPhone,
          normalizedEmail,
          passwordHash,
          normalizedRole,
        ]
      );
    } catch (err) {
      if (isUniqueViolationError(err)) {
        return res.status(409).json({
          ok: false,
          code: "ACCOUNT_EXISTS",
          message: "Account already exists. Please log in.",
        });
      }
      if (!isDbColumnError(err)) throw err;
      try {
        await query(
          "INSERT INTO users (id, email, password_hash, role, verified) VALUES ($1, $2, $3, $4, FALSE)",
          [userId, normalizedEmail, passwordHash, normalizedRole]
        );
      } catch (legacyErr) {
        if (isUniqueViolationError(legacyErr)) {
          return res.status(409).json({
            ok: false,
            code: "ACCOUNT_EXISTS",
            message: "Account already exists. Please log in.",
          });
        }
        throw legacyErr;
      }
    }
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
      to: normalizedEmail,
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
    message: "Account created. Verification code sent.",
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

  const normalized = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return res.status(400).json({ ok: false, message: "Invalid email format" });
  }

  try {
    const { rows } = await query<{ id: string; verified: boolean; email: string }>(
      "SELECT id, verified, email FROM users WHERE LOWER(email) = $1 LIMIT 1",
      [normalized]
    );
    const user = rows[0];

    if (!user) {
      return res.status(404).json({
        ok: false,
        code: "ACCOUNT_NOT_FOUND",
        message: "No account found for this email. Please create an account first.",
      });
    }

    if (user.verified) {
      return res.status(409).json({
        ok: false,
        code: "ACCOUNT_ALREADY_VERIFIED",
        message: "This account is already verified. Please log in.",
      });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await query(
      `INSERT INTO verification_codes (email, code, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = $3`,
      [normalized, code, expiresAt]
    );
    await transporter.sendMail({
      from: fromEmail,
      to: user.email,
      subject: "Your SpareParts Hub verification code",
      text: `Your new verification code is ${code}. It expires in 10 minutes.`,
    });
    log.info({ email: normalized, userId: user.id }, "Verification code resent");
  } catch (err) {
    log.error({ err, email: normalized }, "Resend verification email failed");
    return res.status(500).json({
      ok: false,
      message: "Could not resend verification email",
    });
  }

  return res.json({
    ok: true,
    message: "Verification code resent.",
  });
});


router.post("/login", async (req: Request, res: Response) => {
  const log = req.log;
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: "Email and password are required" });
  }

  const normalizedEmail = email.toLowerCase().trim();
  type LoginUserRow = {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string;
    role: string;
    verified: boolean;
    password_hash: string | null;
  };
  let rows: LoginUserRow[] = [];
  try {
    const result = await query<LoginUserRow>(
      "SELECT id, first_name, last_name, email, role, verified, password_hash FROM users WHERE LOWER(email) = $1",
      [normalizedEmail]
    );
    rows = result.rows;
  } catch (err) {
    if (!isDbColumnError(err)) throw err;
    const result = await query<{
      id: string;
      email: string;
      role: string;
      verified: boolean;
      password_hash: string | null;
    }>(
      "SELECT id, email, role, verified, password_hash FROM users WHERE LOWER(email) = $1",
      [normalizedEmail]
    );
    rows = result.rows.map((row) => ({
      ...row,
      first_name: null,
      last_name: null,
    }));
  }
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

  const token = createAuthToken(user.id);
  log.info({ userId: user.id, email: user.email }, "Login success");

  return res.json({
    ok: true,
    message: "Login success",
    userId: user.id,
    firstName: user.first_name ?? undefined,
    lastName: user.last_name ?? undefined,
    email: user.email,
    role: user.role,
    token,
  });
});

router.post("/forgot-password", async (req: Request, res: Response) => {
  const log = req.log;
  const { email } = req.body as { email?: string };

  if (!email) {
    return res.status(400).json({ ok: false, message: "Email is required" });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const genericResponse = {
    ok: true,
    message:
      "If an account with that email exists, a password reset token has been sent.",
  };

  try {
    const { rows } = await query<{
      id: string;
      email: string;
      verified: boolean;
      password_hash: string | null;
    }>(
      "SELECT id, email, verified, password_hash FROM users WHERE LOWER(email) = $1 LIMIT 1",
      [normalizedEmail]
    );
    const user = rows[0];

    if (!user) {
      log.info({ email: normalizedEmail }, "Forgot password requested for unknown email");
      return res.json(genericResponse);
    }

    const rawToken = randomBytes(24).toString("base64url");
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const resetLink = `sparepartshubmobileclean://reset-password?email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(rawToken)}`;

    await query(
      `INSERT INTO password_reset_tokens (email, token_hash, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET token_hash = $2, expires_at = $3, created_at = NOW()`,
      [normalizedEmail, tokenHash, expiresAt]
    );

    await transporter.sendMail({
      from: fromEmail,
      to: user.email,
      subject: "Reset your SpareParts Hub password",
      text:
        `Tap this link to reset your password: ${resetLink}\n\n` +
        `Or enter this token manually in the app: ${rawToken}\n` +
        `This token expires in 15 minutes.`,
    });
    log.info({ email: normalizedEmail }, "Password reset token sent");
    return res.json(genericResponse);
  } catch (err) {
    log.error({ err, email: normalizedEmail }, "Forgot password failed");
    return res
      .status(500)
      .json({ ok: false, message: "Could not process password reset request" });
  }
});

router.post("/reset-password", async (req: Request, res: Response) => {
  const log = req.log;
  const { email, token, newPassword } = req.body as {
    email?: string;
    token?: string;
    newPassword?: string;
  };

  if (!email || !token || !newPassword) {
    return res.status(400).json({
      ok: false,
      message: "Email, token, and newPassword are required",
    });
  }

  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    return res.status(400).json({ ok: false, message: passwordError });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const tokenHash = hashResetToken(token.trim());

  try {
    const { rows } = await query<{ token_hash: string }>(
      `SELECT token_hash
       FROM password_reset_tokens
       WHERE email = $1 AND expires_at > NOW()
       LIMIT 1`,
      [normalizedEmail]
    );
    const resetRow = rows[0];
    if (!resetRow) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid or expired reset token" });
    }

    const expected = Buffer.from(resetRow.token_hash, "hex");
    const provided = Buffer.from(tokenHash, "hex");
    if (
      expected.length !== provided.length ||
      !timingSafeEqual(expected, provided)
    ) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid or expired reset token" });
    }

    const passwordHash = await hashPassword(newPassword);
    const updateResult = await query(
      "UPDATE users SET password_hash = $1 WHERE LOWER(email) = $2",
      [passwordHash, normalizedEmail]
    );
    await query("DELETE FROM password_reset_tokens WHERE email = $1", [
      normalizedEmail,
    ]);

    if (!updateResult.rowCount) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    log.info({ email: normalizedEmail }, "Password reset successful");
    return res.json({ ok: true, message: "Password reset successful" });
  } catch (err) {
    log.error({ err, email: normalizedEmail }, "Reset password failed");
    return res.status(500).json({ ok: false, message: "Could not reset password" });
  }
});

async function handleVerifyEmail(req: Request, res: Response) {
  const log = req.log;
  const { email, code } = req.body as { email?: string; code?: string };

  if (!email || !code) {
    return res
      .status(400)
      .json({ ok: false, message: "Email and code are required" });
  }

  const normalized = email.toLowerCase().trim();
  const user = await loadVerificationUser(normalized);

  if (!user) {
    return res.status(404).json({ ok: false, message: "No account found for this email" });
  }
  if (user.verified) {
    await query("DELETE FROM verification_codes WHERE email = $1", [normalized]);
    return res.status(409).json({ ok: false, message: "This account is already verified. Please log in." });
  }

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
  await query("UPDATE users SET verified = TRUE WHERE id = $1", [user.id]);
  log.info({ email: normalized, userId: user.id }, "Email verified");

  let welcomeEmailSent = false;
  if (!user.welcome_email_sent_at) {
    try {
      welcomeEmailSent = await sendWelcomeEmailAfterVerification({
        userId: user.id,
        email: user.email,
        firstName: user.first_name,
        log,
      });
      log.info({ email: normalized, userId: user.id }, "Welcome email sent after verification");
    } catch (welcomeErr) {
      log.warn({ err: welcomeErr, email: normalized, userId: user.id }, "Welcome email failed after verification");
    }
  }

  return res.json({
    ok: true,
    message: welcomeEmailSent
      ? "Email verified successfully. Your account is active and your welcome email has been sent."
      : "Email verified successfully. Your account is active.",
    email: normalized,
    welcomeEmailSent,
  });
}

router.post("/verify", handleVerifyEmail);
router.post("/verify-email", handleVerifyEmail);

export default router;
