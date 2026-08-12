import "dotenv/config";
import { pool } from "../db";
import { normalizeNigerianPhone } from "../services/phoneNumbers";

type UserRow = { id: string; phone: string | null; phone_e164: string | null; role: string };

function masked(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length > 4 ? `***${digits.slice(-4)}` : "***";
}

async function main() {
  const result = await pool.query<UserRow>(
    "SELECT id, phone, phone_e164, role FROM users WHERE deleted_at IS NULL ORDER BY created_at"
  );
  const invalid: Array<{ userId: string; role: string; phone: string }> = [];
  const normalized = new Map<string, string[]>();
  let missing = 0;
  for (const user of result.rows) {
    const source = user.phone_e164 || user.phone;
    if (!source) {
      missing += 1;
      continue;
    }
    try {
      const phone = normalizeNigerianPhone(source);
      normalized.set(phone, [...(normalized.get(phone) || []), user.id]);
    } catch {
      invalid.push({ userId: user.id, role: user.role, phone: masked(source) });
    }
  }
  const duplicates = [...normalized.entries()]
    .filter(([, userIds]) => userIds.length > 1)
    .map(([phone, userIds]) => ({ phone: masked(phone), userIds }));
  process.stdout.write(`${JSON.stringify({
    generatedAt: new Date().toISOString(), usersScanned: result.rowCount,
    missingPhone: missing, invalid, duplicates,
  }, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Phone migration report failed");
    process.exitCode = 1;
  })
  .finally(async () => pool.end());
