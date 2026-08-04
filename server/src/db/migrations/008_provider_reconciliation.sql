ALTER TABLE payout_ledger ADD COLUMN IF NOT EXISTS merchant_reference TEXT;
UPDATE payout_ledger SET merchant_reference = id WHERE merchant_reference IS NULL;
ALTER TABLE payout_ledger ALTER COLUMN merchant_reference SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_ledger_merchant_reference
  ON payout_ledger (merchant_reference);

ALTER TABLE payout_ledger
  ADD COLUMN IF NOT EXISTS reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE payment_refunds
  ADD COLUMN IF NOT EXISTS reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0;

UPDATE payout_ledger
SET status = 'manual_review',
    failure_reason = COALESCE(failure_reason, 'Legacy failed payout requires provider review'),
    updated_at = NOW()
WHERE status = 'failed';

UPDATE payment_refunds
SET status = 'manual_review',
    last_error = COALESCE(last_error, 'Legacy failed refund requires provider review'),
    updated_at = NOW()
WHERE status = 'failed';

UPDATE payment_transactions p
SET refund_status = 'manual_review', updated_at = NOW()
WHERE p.id IN (
  SELECT payment_id FROM payment_refunds WHERE status = 'manual_review'
)
  AND p.refund_status = 'failed';

DROP INDEX IF EXISTS idx_payment_refunds_retry;
CREATE INDEX idx_payment_refunds_retry
  ON payment_refunds (status, next_attempt_at)
  WHERE status IN ('pending', 'processing', 'reconciliation_required');

DROP INDEX IF EXISTS idx_payout_ledger_retry;
CREATE INDEX idx_payout_ledger_retry
  ON payout_ledger (status, next_attempt_at)
  WHERE status IN ('held', 'ready', 'processing', 'reconciliation_required');
