ALTER TABLE payment_refunds ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_refunds ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE payment_refunds ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_payment_refunds_retry
  ON payment_refunds (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');

