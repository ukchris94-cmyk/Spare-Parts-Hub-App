import "dotenv/config";
import { query, pool } from "../db";

function getArg(flag: string): string | null {
  const index = process.argv.findIndex((value) => value === flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function printUsage() {
  console.log(
    "Usage: npm run promote-admin -- --email <user@example.com>"
  );
}

async function main() {
  const rawEmail = getArg("--email");
  if (!rawEmail) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("Invalid email format.");
    process.exitCode = 1;
    return;
  }

  const existing = await query<{ id: string; role: string }>(
    "SELECT id, role FROM users WHERE LOWER(email) = $1 LIMIT 1",
    [email]
  );

  const user = existing.rows[0];
  if (!user) {
    console.error("User not found. Create and verify the user first.");
    process.exitCode = 1;
    return;
  }

  if (user.role === "admin") {
    console.log(`User ${email} is already an admin.`);
    return;
  }

  await query(
    "UPDATE users SET role = 'admin', verified = TRUE WHERE id = $1",
    [user.id]
  );

  console.log(`Promoted ${email} to admin.`);
}

main()
  .catch((err) => {
    console.error("Failed to promote admin:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
