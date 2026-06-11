import "dotenv/config";
import { randomBytes, scrypt } from "crypto";
import { promisify } from "util";
import { pool, query } from "../db";

const scryptAsync = promisify(scrypt);
const roles = ["admin", "staff", "vendor", "mechanic", "dispatcher", "user"] as const;

type TestRole = (typeof roles)[number];

function getArg(flag: string): string | null {
  const index = process.argv.findIndex((value) => value === flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  TEST_USER_PASSWORD='<password>' npm run create-test-users",
      "",
      "Optional:",
      "  npm run create-test-users -- --password '<password>' --prefix test --domain example.com",
      "",
      "Creates/updates:",
      "  test.admin@example.com",
      "  test.staff@example.com",
      "  test.vendor@example.com",
      "  test.mechanic@example.com",
      "  test.dispatcher@example.com",
      "  test.user@example.com",
    ].join("\n")
  );
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function validatePassword(password: string): string | null {
  if (!password || password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 128) return "Password is too long.";
  return null;
}

function toTitle(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}

async function upsertTestUser(role: TestRole, email: string, passwordHash: string) {
  const existing = await query<{ id: string }>(
    "SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1",
    [email]
  );
  const user = existing.rows[0];
  const firstName = "Test";
  const lastName = toTitle(role);

  if (user) {
    await query(
      `UPDATE users
       SET first_name = $1,
           last_name = $2,
           password_hash = $3,
           role = $4,
           verified = TRUE
       WHERE id = $5`,
      [firstName, lastName, passwordHash, role, user.id]
    );
    return { email, role, action: "updated" as const };
  }

  const id = genId("usr");
  await query(
    `INSERT INTO users (id, first_name, last_name, email, password_hash, role, verified)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
    [id, firstName, lastName, email, passwordHash, role]
  );
  return { email, role, action: "created" as const };
}

async function main() {
  const password = getArg("--password") ?? process.env.TEST_USER_PASSWORD ?? "";
  const prefix = (getArg("--prefix") ?? process.env.TEST_USER_PREFIX ?? "test")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
  const domain = (getArg("--domain") ?? process.env.TEST_USER_DOMAIN ?? "example.com")
    .trim()
    .toLowerCase();

  const passwordError = validatePassword(password);
  if (passwordError) {
    printUsage();
    console.error(passwordError);
    process.exitCode = 1;
    return;
  }

  if (!prefix || !/^[^\s@]+\.[^\s@]+$/.test(`test@${domain}`)) {
    printUsage();
    console.error("Invalid prefix or domain.");
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);
  const rows = [];
  for (const role of roles) {
    const email = `${prefix}.${role}@${domain}`;
    rows.push(await upsertTestUser(role, email, passwordHash));
  }

  console.log("Test users ready:");
  for (const row of rows) {
    console.log(`- ${row.email} (${row.role}) ${row.action}`);
  }
}

main()
  .catch((err) => {
    console.error("Failed to create test users:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
