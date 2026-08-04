ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS queue_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_outbox_events_dispatch
  ON outbox_events (status, available_at, created_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_outbox_events_stale_locks
  ON outbox_events (locked_at)
  WHERE status = 'processing';
