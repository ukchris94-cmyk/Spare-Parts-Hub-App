-- Persist vendor and mechanic business identity collected during onboarding.

ALTER TABLE users ADD COLUMN IF NOT EXISTS business_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS specialization TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT;

CREATE INDEX IF NOT EXISTS idx_users_business_role_name
  ON users (role, LOWER(business_name))
  WHERE business_name IS NOT NULL AND deleted_at IS NULL;
