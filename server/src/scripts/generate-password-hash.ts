import { randomBytes, scrypt } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt);

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}

async function main() {
  const password = process.argv[2];

  if (!password) {
    console.error("Usage: npx ts-node src/scripts/generate-password-hash.ts 'NewPassword123!'");
    process.exit(1);
  }

  const hash = await hashPassword(password);
  console.log(hash);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});