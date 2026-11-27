ALTER TABLE commands ADD COLUMN ack_started_at TEXT
  CHECK (phase NOT IN ('ack_intent', 'acked', 'actuation_intent') OR ack_started_at IS NOT NULL);
