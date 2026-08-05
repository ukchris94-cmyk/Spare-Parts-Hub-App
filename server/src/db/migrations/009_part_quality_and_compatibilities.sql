ALTER TABLE parts ADD COLUMN IF NOT EXISTS quality TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'parts_quality_check'
  ) THEN
    ALTER TABLE parts ADD CONSTRAINT parts_quality_check
      CHECK (quality IS NULL OR quality IN ('excellent', 'good', 'fair', 'needs_refurbishment'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS part_compatibilities (
  id TEXT PRIMARY KEY,
  part_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2200),
  trim TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_part_compatibilities_part
  ON part_compatibilities (part_id);
CREATE INDEX IF NOT EXISTS idx_part_compatibilities_vehicle
  ON part_compatibilities (lower(make), lower(model), year);
CREATE UNIQUE INDEX IF NOT EXISTS idx_part_compatibilities_unique
  ON part_compatibilities (
    part_id,
    lower(make),
    lower(model),
    year,
    lower(COALESCE(trim, ''))
  );
