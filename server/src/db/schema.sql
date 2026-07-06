-- Spare Parts Hub schema (PostgreSQL)
-- Run once after creating the database: psql $DATABASE_URL -f src/db/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  first_name TEXT,
  last_name  TEXT,
  email      TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role       TEXT NOT NULL,
  verified   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_email_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));

-- Vehicles saved in "My Garage"
CREATE TABLE IF NOT EXISTS vehicles (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year       INTEGER,
  mileage    INTEGER,
  make       TEXT,
  model      TEXT,
  trim       TEXT,
  engine     TEXT,
  vin        TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS mileage INTEGER;

CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles (user_id, is_primary);

CREATE TABLE IF NOT EXISTS verification_codes (
  email     TEXT NOT NULL PRIMARY KEY,
  code      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  email      TEXT NOT NULL PRIMARY KEY,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Order line items stored as JSONB for flexibility (e.g. [{ partId, quantity, unitPrice }])
ALTER TABLE orders ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatcher_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_up_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_orders_dispatcher_status
  ON orders (dispatcher_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  order_id TEXT UNIQUE REFERENCES orders(id) ON DELETE SET NULL,
  amount_kobo INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL,
  items JSONB NOT NULL DEFAULT '[]',
  access_code TEXT,
  authorization_url TEXT,
  paystack_transaction_id TEXT,
  paystack_domain TEXT,
  paystack_channel TEXT,
  gateway_response TEXT,
  paystack_response JSONB,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  initialized_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_user_created
  ON payment_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_status
  ON payment_transactions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS delivery_jobs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  vendor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dispatcher_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  pickup_details TEXT,
  dropoff_details TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  issue_note TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  heading_to_pickup_at TIMESTAMPTZ,
  arrived_at_pickup_at TIMESTAMPTZ,
  picked_up_at TIMESTAMPTZ,
  heading_to_dropoff_at TIMESTAMPTZ,
  arrived_at_dropoff_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_delivery_jobs_available
  ON delivery_jobs (status, created_at DESC)
  WHERE dispatcher_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_jobs_dispatcher_status
  ON delivery_jobs (dispatcher_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS part_requests (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  vehicle     TEXT,
  part_description TEXT,
  urgency     TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS part_request_quotes (
  id               TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL REFERENCES part_requests(id) ON DELETE CASCADE,
  vendor_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  part_id          TEXT REFERENCES parts(id) ON DELETE SET NULL,
  price_ngn        INTEGER NOT NULL,
  eta_minutes      INTEGER,
  note             TEXT,
  status           TEXT NOT NULL DEFAULT 'open',
  counter_price_ngn INTEGER,
  counter_note     TEXT,
  countered_by     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, vendor_user_id)
);

CREATE INDEX IF NOT EXISTS idx_part_request_quotes_request
  ON part_request_quotes (request_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_part_request_quotes_vendor
  ON part_request_quotes (vendor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS parts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  image_url   TEXT,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  price_ngn   INTEGER,
  stock_qty   INTEGER,
  role        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE parts ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS price_ngn INTEGER;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS stock_qty INTEGER;
CREATE INDEX IF NOT EXISTS idx_parts_user ON parts (user_id);

CREATE TABLE IF NOT EXISTS onboarding_images (
  id            TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size          INTEGER NOT NULL,
  storage_path  TEXT NOT NULL,
  access_url    TEXT NOT NULL,
  uploaded_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_images_created_at
  ON onboarding_images (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_onboarding_images_uploaded_by
  ON onboarding_images (uploaded_by);

ALTER TABLE onboarding_images ADD COLUMN IF NOT EXISTS vendor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE onboarding_images ADD COLUMN IF NOT EXISTS part_id TEXT REFERENCES parts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_onboarding_images_vendor_user
  ON onboarding_images (vendor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_onboarding_images_part
  ON onboarding_images (part_id);


CREATE TABLE IF NOT EXISTS bargain_offers (
  id              TEXT PRIMARY KEY,
  part_id         TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  vendor_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  buyer_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offer_price_ngn INTEGER NOT NULL,
  note            TEXT,
  vendor_reply    TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bargain_offers_vendor
  ON bargain_offers (vendor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bargain_offers_buyer
  ON bargain_offers (buyer_user_id, created_at DESC);
ALTER TABLE bargain_offers ADD COLUMN IF NOT EXISTS accepted_price_ngn INTEGER;
ALTER TABLE bargain_offers ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE bargain_offers ADD COLUMN IF NOT EXISTS used_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bargain_offers_part
  ON bargain_offers (part_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bargain_offer_messages (
  id               TEXT PRIMARY KEY,
  bargain_offer_id TEXT NOT NULL REFERENCES bargain_offers(id) ON DELETE CASCADE,
  sender_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bargain_offer_messages_offer
  ON bargain_offer_messages (bargain_offer_id, created_at ASC);

CREATE TABLE IF NOT EXISTS notifications (
  id                TEXT PRIMARY KEY,
  recipient_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  recipient_role    TEXT NOT NULL,
  type              TEXT NOT NULL,
  title             TEXT NOT NULL,
  message           TEXT NOT NULL,
  related_order_id  TEXT REFERENCES orders(id) ON DELETE CASCADE,
  related_job_id    TEXT,
  read              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS related_bargain_offer_id TEXT REFERENCES bargain_offers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_user_read
  ON notifications (recipient_user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_role_read
  ON notifications (recipient_role, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_bargain_offer
  ON notifications (related_bargain_offer_id);

CREATE TABLE IF NOT EXISTS push_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  platform   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user
  ON push_tokens (user_id);
