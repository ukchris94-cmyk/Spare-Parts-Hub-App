import { withClient, query } from "../../db";

export async function expireAbandonedCheckouts(limit = 50): Promise<number> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const expired = await client.query<{ id: string }>(
        `SELECT id FROM payment_transactions
         WHERE status IN ('awaiting_transfer', 'awaiting_card') AND expires_at < NOW()
         ORDER BY expires_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [limit]
      );
      for (const payment of expired.rows) {
        const reservations = await client.query<{ part_id: string; quantity: number }>(
          `UPDATE inventory_reservations
           SET status = 'released', released_at = NOW()
           WHERE payment_id = $1 AND status = 'reserved'
           RETURNING part_id, quantity`,
          [payment.id]
        );
        for (const reservation of reservations.rows) {
          await client.query("UPDATE parts SET stock_qty = stock_qty + $2 WHERE id = $1", [
            reservation.part_id,
            reservation.quantity,
          ]);
        }
        await client.query(
          "UPDATE bargain_offers SET reserved_payment_id = NULL, reserved_until = NULL WHERE reserved_payment_id = $1",
          [payment.id]
        );
        await client.query(
          "UPDATE part_request_quotes SET reserved_payment_id = NULL, reserved_until = NULL WHERE reserved_payment_id = $1",
          [payment.id]
        );
        await client.query(
          "UPDATE payment_transactions SET status = 'expired', updated_at = NOW() WHERE id = $1",
          [payment.id]
        );
      }
      await client.query("COMMIT");
      return expired.rowCount || 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function cleanupExpiredSessions(): Promise<number> {
  const result = await query(
    `DELETE FROM auth_sessions
     WHERE expires_at < NOW() - INTERVAL '7 days'
        OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '30 days')`
  );
  return result.rowCount;
}

