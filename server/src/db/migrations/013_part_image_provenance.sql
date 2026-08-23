ALTER TABLE part_images
  ADD COLUMN IF NOT EXISTS image_kind TEXT NOT NULL DEFAULT 'inventory',
  ADD COLUMN IF NOT EXISTS source_name TEXT,
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS license_name TEXT,
  ADD COLUMN IF NOT EXISTS license_url TEXT,
  ADD COLUMN IF NOT EXISTS attribution TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'part_images_kind_check'
  ) THEN
    ALTER TABLE part_images
      ADD CONSTRAINT part_images_kind_check
      CHECK (image_kind IN ('inventory', 'catalog_reference'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'part_images_reference_rights_check'
  ) THEN
    ALTER TABLE part_images
      ADD CONSTRAINT part_images_reference_rights_check
      CHECK (
        image_kind = 'inventory'
        OR (
          NULLIF(BTRIM(source_url), '') IS NOT NULL
          AND NULLIF(BTRIM(license_name), '') IS NOT NULL
          AND NULLIF(BTRIM(license_url), '') IS NOT NULL
          AND NULLIF(BTRIM(attribution), '') IS NOT NULL
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_part_images_kind_order
  ON part_images (part_id, image_kind, sort_order, created_at);
