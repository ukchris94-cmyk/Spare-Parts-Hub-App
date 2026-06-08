import "dotenv/config";
import { randomBytes, scrypt } from "crypto";
import { promisify } from "util";
import { pool, query } from "../db";

const scryptAsync = promisify(scrypt);

function getArg(flag: string): string | null {
  const index = process.argv.findIndex((value) => value === flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  npm run create-admin -- --email <admin@example.com> --password <password> [--first-name <name>] [--last-name <name>]",
      "",
      "You can also provide the password with ADMIN_PASSWORD to avoid putting it in the command:",
      "  ADMIN_PASSWORD='<password>' npm run create-admin -- --email <admin@example.com>",
    ].join("\n")
  );
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password: string): string | null {
  if (!password || password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 128) return "Password is too long.";
  return null;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}

async function main() {
  const rawEmail = getArg("--email") ?? process.env.ADMIN_EMAIL ?? "";
  const password = getArg("--password") ?? process.env.ADMIN_PASSWORD ?? "";
  const firstName = getArg("--first-name") ?? process.env.ADMIN_FIRST_NAME ?? null;
  const lastName = getArg("--last-name") ?? process.env.ADMIN_LAST_NAME ?? null;

  const email = rawEmail.trim().toLowerCase();
  if (!email || !validateEmail(email)) {
    printUsage();
    console.error("Invalid or missing email.");
    process.exitCode = 1;
    return;
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    printUsage();
    console.error(passwordError);
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);
  const existing = await query<{ id: string; role: string }>(
    "SELECT id, role FROM users WHERE LOWER(email) = $1 LIMIT 1",
    [email]
  );
  const user = existing.rows[0];

  if (user) {
    await query(
      `UPDATE users
       SET role = 'admin', verified = TRUE, password_hash = $1,
           first_name = COALESCE($2, first_name),
           last_name = COALESCE($3, last_name)
       WHERE id = $4`,
      [passwordHash, firstName, lastName, user.id]
    );
    console.log(`Updated existing user ${email} to admin.`);
    return;
  }

  const userId = genId("usr");
  await query(
    `INSERT INTO users (id, first_name, last_name, email, password_hash, role, verified)
     VALUES ($1, $2, $3, $4, $5, 'admin', TRUE)`,
    [userId, firstName, lastName, email, passwordHash]
  );

  console.log(`Created admin user ${email}.`);
}

main()
  .catch((err) => {
    console.error("Failed to create admin:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
