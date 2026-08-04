ALTER TABLE vendor_payout_accounts ADD COLUMN IF NOT EXISTS account_number_ciphertext TEXT;
ALTER TABLE vendor_payout_accounts ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE vendor_payout_accounts ADD COLUMN IF NOT EXISTS provider_response JSONB;

ALTER TABLE payout_ledger ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payout_ledger ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE payout_ledger ADD COLUMN IF NOT EXISTS provider_response JSONB;

CREATE INDEX IF NOT EXISTS idx_payout_ledger_retry
  ON payout_ledger (status, next_attempt_at)
  WHERE status IN ('held', 'ready', 'failed');

