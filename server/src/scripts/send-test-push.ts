import "dotenv/config";
import { pool, query } from "../db";
import { createNotification } from "../services/notifications";

function getArg(flag: string): string | null {
  const index = process.argv.findIndex((value) => value === flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  npm run send-test-push -- --email user@example.com",
      "  npm run send-test-push -- --user-id usr_...",
      "",
      "Optional:",
      "  --title 'Test push'",
      "  --message 'This is a test notification'",
    ].join("\n"),
  );
}

async function main() {
  const email = getArg("--email")?.trim().toLowerCase() ?? "";
  const userIdArg = getArg("--user-id")?.trim() ?? "";
  const title = getArg("--title")?.trim() || "Spare Parts Hub test push";
  const message =
    getArg("--message")?.trim() ||
    "If you received this, iOS push delivery is working for this device.";

  if (!email && !userIdArg) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const { rows } = await query<{ id: string; role: string; email: string }>(
    userIdArg
      ? "SELECT id, role, email FROM users WHERE id = $1 LIMIT 1"
      : "SELECT id, role, email FROM users WHERE LOWER(email) = $1 LIMIT 1",
    [userIdArg || email],
  );
  const user = rows[0];
  if (!user) {
    console.error("User not found.");
    process.exitCode = 1;
    return;
  }

  const tokenResult = await query<{ platform: string | null; count: string }>(
    `SELECT COALESCE(platform, 'unknown') AS platform, COUNT(*)::text AS count
     FROM push_tokens
     WHERE user_id = $1
     GROUP BY COALESCE(platform, 'unknown')
     ORDER BY platform`,
    [user.id],
  );

  console.log({
    userId: user.id,
    email: user.email,
    role: user.role,
    savedPushTokens: tokenResult.rows.map((row) => ({
      platform: row.platform,
      count: Number.parseInt(row.count, 10) || 0,
    })),
  });

  await createNotification({
    recipientUserId: user.id,
    recipientRole: user.role,
    type: "push_test",
    title,
    message,
  });

  console.log("Test notification queued. Check server logs for Expo ticket/receipt results.");
}

main()
  .catch((error) => {
    console.error("Test push failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    pool.end().catch(() => undefined);
  });
