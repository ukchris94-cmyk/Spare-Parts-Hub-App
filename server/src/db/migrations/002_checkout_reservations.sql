ALTER TABLE bargain_offers ADD COLUMN IF NOT EXISTS reserved_payment_id TEXT REFERENCES payment_transactions(id) ON DELETE SET NULL;
ALTER TABLE bargain_offers ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_bargain_offers_payment_reservation
  ON bargain_offers (reserved_payment_id, reserved_until)
  WHERE reserved_payment_id IS NOT NULL;

ALTER TABLE part_request_quotes ADD COLUMN IF NOT EXISTS reserved_payment_id TEXT REFERENCES payment_transactions(id) ON DELETE SET NULL;
ALTER TABLE part_request_quotes ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_part_request_quotes_payment_reservation
  ON part_request_quotes (reserved_payment_id, reserved_until)
  WHERE reserved_payment_id IS NOT NULL;

