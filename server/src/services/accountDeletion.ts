import { randomUUID } from "crypto";
import { PoolClient } from "pg";
import { withClient } from "../db";

type DbClient = Pick<PoolClient, "query">;

type DeletionResult = {
  status: "deleted" | "scheduled";
  message: string;
};

async function hasActiveObligations(client: DbClient, userId: string): Promise<boolean> {
  const result = await client.query<{ active: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM orders
         WHERE user_id = $1 AND status NOT IN ('delivered', 'cancelled', 'rejected')
       )
       OR EXISTS (
         SELECT 1
         FROM orders o
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) item
         WHERE item->>'vendorUserId' = $1
           AND o.status NOT IN ('delivered', 'cancelled', 'rejected')
       )
       OR EXISTS (
         SELECT 1 FROM delivery_jobs
         WHERE (vendor_id = $1 OR dispatcher_id = $1)
           AND status NOT IN ('delivered', 'cancelled', 'failed')
       )
       OR EXISTS (
         SELECT 1 FROM payment_transactions
         WHERE user_id = $1
           AND (
             status IN ('awaiting_transfer', 'awaiting_card')
             OR refund_status IN (
               'pending',
               'processing',
               'reconciliation_required',
               'manual_review',
               'failed'
             )
           )
       )
       OR EXISTS (
         SELECT 1 FROM payout_ledger
         WHERE vendor_id = $1 AND status NOT IN ('paid', 'cancelled')
       )
     ) AS active`,
    [userId]
  );
  return Boolean(result.rows[0]?.active);
}

async function anonymizeAccount(
  client: DbClient,
  user: { id: string; email: string }
): Promise<void> {
  await client.query("DELETE FROM vehicles WHERE user_id = $1", [user.id]);
  await client.query("DELETE FROM push_tokens WHERE user_id = $1", [user.id]);
  await client.query("DELETE FROM notifications WHERE recipient_user_id = $1", [user.id]);
  await client.query("DELETE FROM auth_sessions WHERE user_id = $1", [user.id]);
  await client.query("DELETE FROM vendor_pickup_locations WHERE vendor_id = $1", [user.id]);
  await client.query("DELETE FROM vendor_payout_accounts WHERE vendor_id = $1", [user.id]);
  await client.query("DELETE FROM verification_codes WHERE LOWER(email) = LOWER($1)", [user.email]);
  await client.query("DELETE FROM password_reset_tokens WHERE LOWER(email) = LOWER($1)", [user.email]);
  await client.query("UPDATE parts SET user_id = NULL, stock_qty = 0 WHERE user_id = $1", [user.id]);
  await client.query("UPDATE media_objects SET owner_id = NULL WHERE owner_id = $1", [user.id]);
  await client.query(
    `UPDATE users
     SET first_name = NULL,
         last_name = NULL,
         phone = NULL,
         email = $2,
         password_hash = NULL,
         verified = FALSE,
         token_version = token_version + 1,
         deleted_at = NOW(),
         anonymized_at = NOW(),
         deletion_requested_at = COALESCE(deletion_requested_at, NOW()),
         welcome_email_sent_at = NULL
     WHERE id = $1`,
    [user.id, `deleted+${user.id}@deleted.quickserve.invalid`]
  );
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1, NULL, 'account.anonymized', 'user', $2, '{"source":"self_service"}'::jsonb)`,
    [`audit_${randomUUID()}`, user.id]
  );
}

export async function requestAccountDeletion(userId: string): Promise<DeletionResult> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await client.query<{
        id: string;
        email: string;
        deleted_at: string | null;
        deletion_requested_at: string | null;
      }>(
        `SELECT id, email, deleted_at, deletion_requested_at
         FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
      );
      const user = result.rows[0];
      if (!user || user.deleted_at) {
        await client.query("COMMIT");
        return { status: "deleted", message: "Account data has already been deleted." };
      }

      if (await hasActiveObligations(client, userId)) {
        await client.query(
          `UPDATE users
           SET deletion_requested_at = COALESCE(deletion_requested_at, NOW()),
               token_version = CASE
                 WHEN deletion_requested_at IS NULL THEN token_version + 1
                 ELSE token_version
               END
           WHERE id = $1`,
          [userId]
        );
        await client.query(
          "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1",
          [userId]
        );
        await client.query("COMMIT");
        return {
          status: "scheduled",
          message: "Account deletion is scheduled after active orders, deliveries, or payouts are resolved.",
        };
      }

      await anonymizeAccount(client, user);
      await client.query("COMMIT");
      return { status: "deleted", message: "Your account and personal profile data were deleted." };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function processPendingAccountDeletions(limit = 10): Promise<number> {
  const pending = await withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM users
       WHERE deletion_requested_at IS NOT NULL AND deleted_at IS NULL
       ORDER BY deletion_requested_at
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  });

  let deleted = 0;
  for (const user of pending) {
    const result = await requestAccountDeletion(user.id);
    if (result.status === "deleted") deleted += 1;
  }
  return deleted;
}
