ALTER TABLE parts ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS brand TEXT;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS manufacturer_part_number TEXT;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS applicability_type TEXT;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS specifications JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS listing_status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE parts ADD COLUMN IF NOT EXISTS applicability_review_note TEXT;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS applicability_reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS applicability_reviewed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_applicability_type_check') THEN
    ALTER TABLE parts ADD CONSTRAINT parts_applicability_type_check
      CHECK (applicability_type IS NULL OR applicability_type IN ('vehicle', 'specification', 'universal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_listing_status_check') THEN
    ALTER TABLE parts ADD CONSTRAINT parts_listing_status_check
      CHECK (listing_status IN ('published', 'pending_review'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_specifications_array_check') THEN
    ALTER TABLE parts ADD CONSTRAINT parts_specifications_array_check
      CHECK (jsonb_typeof(specifications) = 'array');
  END IF;
END $$;

UPDATE parts p
SET applicability_type = 'vehicle'
WHERE applicability_type IS NULL
  AND EXISTS (SELECT 1 FROM part_compatibilities pc WHERE pc.part_id = p.id);

CREATE INDEX IF NOT EXISTS idx_parts_category ON parts (lower(category));
CREATE INDEX IF NOT EXISTS idx_parts_brand ON parts (lower(brand));
CREATE INDEX IF NOT EXISTS idx_parts_manufacturer_part_number ON parts (lower(manufacturer_part_number));
CREATE INDEX IF NOT EXISTS idx_parts_applicability ON parts (applicability_type, listing_status);
CREATE INDEX IF NOT EXISTS idx_parts_specifications ON parts USING GIN (specifications);
