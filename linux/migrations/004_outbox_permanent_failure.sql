ALTER TABLE outbox ADD COLUMN failed_at TEXT
  CHECK (failed_at IS NULL OR (delivered_at IS NULL AND last_error IS NOT NULL AND length(trim(last_error)) > 0));

DROP INDEX outbox_pending_idx;
CREATE INDEX outbox_pending_idx ON outbox(julianday(next_attempt_at), id)
  WHERE delivered_at IS NULL AND failed_at IS NULL;
