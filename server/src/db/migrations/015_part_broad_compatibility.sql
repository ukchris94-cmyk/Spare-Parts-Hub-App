ALTER TABLE parts ADD COLUMN IF NOT EXISTS broad_compatibility_scope TEXT;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS broad_vehicle_makes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE parts ADD COLUMN IF NOT EXISTS broad_year_scope TEXT;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS broad_year_from INTEGER;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS broad_year_to INTEGER;

UPDATE parts
SET broad_compatibility_scope = 'all_makes',
    broad_vehicle_makes = ARRAY[]::TEXT[],
    broad_year_scope = 'all_years',
    broad_year_from = NULL,
    broad_year_to = NULL
WHERE applicability_type = 'universal'
  AND listing_status = 'published'
  AND broad_compatibility_scope IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_broad_scope_check') THEN
    ALTER TABLE parts ADD CONSTRAINT parts_broad_scope_check
      CHECK (broad_compatibility_scope IS NULL OR broad_compatibility_scope IN ('selected_makes', 'all_makes'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_broad_year_scope_check') THEN
    ALTER TABLE parts ADD CONSTRAINT parts_broad_year_scope_check
      CHECK (broad_year_scope IS NULL OR broad_year_scope IN ('all_years', 'year_range'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_broad_year_range_check') THEN
    ALTER TABLE parts ADD CONSTRAINT parts_broad_year_range_check
      CHECK (
        (broad_year_from IS NULL AND broad_year_to IS NULL)
        OR (broad_year_from BETWEEN 1980 AND 2200 AND broad_year_to BETWEEN broad_year_from AND 2200)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_broad_shape_check') THEN
    ALTER TABLE parts ADD CONSTRAINT parts_broad_shape_check
      CHECK (
        (broad_compatibility_scope IS NULL
          AND cardinality(broad_vehicle_makes) = 0
          AND broad_year_scope IS NULL
          AND broad_year_from IS NULL
          AND broad_year_to IS NULL)
        OR (broad_compatibility_scope = 'all_makes'
          AND cardinality(broad_vehicle_makes) = 0
          AND broad_year_scope = 'all_years'
          AND broad_year_from IS NULL
          AND broad_year_to IS NULL)
        OR (broad_compatibility_scope = 'selected_makes'
          AND cardinality(broad_vehicle_makes) BETWEEN 1 AND 20
          AND (
            (broad_year_scope = 'all_years' AND broad_year_from IS NULL AND broad_year_to IS NULL)
            OR (broad_year_scope = 'year_range' AND broad_year_from IS NOT NULL AND broad_year_to IS NOT NULL)
          ))
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_parts_broad_vehicle_makes
  ON parts USING GIN (broad_vehicle_makes);
CREATE INDEX IF NOT EXISTS idx_parts_broad_scope
  ON parts (broad_compatibility_scope, broad_year_scope, broad_year_from, broad_year_to);
