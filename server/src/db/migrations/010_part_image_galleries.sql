CREATE TABLE IF NOT EXISTS part_images (
  media_id    TEXT PRIMARY KEY REFERENCES media_objects(id) ON DELETE CASCADE,
  part_id     TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  storage_uri TEXT NOT NULL UNIQUE,
  sort_order  INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_part_images_part
  ON part_images (part_id, sort_order, created_at);

INSERT INTO part_images (media_id, part_id, storage_uri, sort_order)
SELECT mo.id, p.id, p.image_url, 0
FROM parts p
JOIN media_objects mo
  ON p.image_url = 's3://' || mo.bucket || '/' || mo.object_key
WHERE p.image_url IS NOT NULL
  AND mo.purpose = 'part_image'
  AND mo.status = 'verified'
  AND mo.deleted_at IS NULL
ON CONFLICT DO NOTHING;
