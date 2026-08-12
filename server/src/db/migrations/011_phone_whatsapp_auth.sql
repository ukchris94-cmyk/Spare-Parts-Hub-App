-- Phone-first public authentication and provider-neutral message delivery.

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
DROP INDEX IF EXISTS idx_users_email;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users (LOWER(email))
  WHERE email IS NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_e164 TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_security_consent_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_transaction_consent_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_e164_unique
  ON users (phone_e164)
  WHERE phone_e164 IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_challenges (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT REFERENCES users(id) ON DELETE CASCADE,
  purpose               TEXT NOT NULL CHECK (purpose IN ('signup', 'phone_migration', 'phone_change', 'password_reset')),
  pending_phone_e164    TEXT NOT NULL,
  destination_hmac      TEXT NOT NULL,
  ip_hmac               TEXT NOT NULL,
  code_hash             TEXT NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 5,
  last_sent_at          TIMESTAMPTZ,
  last_channel          TEXT CHECK (last_channel IN ('whatsapp', 'sms')),
  provider_message_id   TEXT,
  provider_status       TEXT,
  reset_token_hash      TEXT,
  reset_token_expires_at TIMESTAMPTZ,
  consumed_at           TIMESTAMPTZ,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_challenges_user
  ON auth_challenges (user_id, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_destination
  ON auth_challenges (destination_hmac, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_reset_token
  ON auth_challenges (reset_token_hash)
  WHERE reset_token_hash IS NOT NULL AND consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_message_attempts (
  id                  TEXT PRIMARY KEY,
  challenge_id        TEXT NOT NULL REFERENCES auth_challenges(id) ON DELETE CASCADE,
  destination_hmac    TEXT NOT NULL,
  ip_hmac             TEXT NOT NULL,
  purpose             TEXT NOT NULL,
  channel             TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  provider            TEXT NOT NULL,
  provider_message_id TEXT,
  status              TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_message_attempts_destination
  ON auth_message_attempts (destination_hmac, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_message_attempts_ip
  ON auth_message_attempts (ip_hmac, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_message_attempts_provider_message
  ON auth_message_attempts (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_receipt_deliveries (
  payment_transaction_id TEXT PRIMARY KEY REFERENCES payment_transactions(id) ON DELETE CASCADE,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                TEXT NOT NULL,
  provider_message_id     TEXT,
  status                  TEXT NOT NULL DEFAULT 'pending',
  attempt_count           INTEGER NOT NULL DEFAULT 0,
  last_error              TEXT,
  sent_at                 TIMESTAMPTZ,
  delivered_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_receipt_provider_message
  ON payment_receipt_deliveries (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
