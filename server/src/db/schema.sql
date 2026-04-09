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

CREATE TABLE IF NOT EXISTS part_requests (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  vehicle     TEXT,
  part_description TEXT,
  urgency     TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
