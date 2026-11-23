ALTER TABLE device_state
  ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'delivered'
  CHECK (delivery_state IN ('pending', 'delivered'));

ALTER TABLE device_state ADD COLUMN server_time TEXT;
ALTER TABLE device_state ADD COLUMN clock_offset_ms INTEGER;
ALTER TABLE device_state ADD COLUMN request_id TEXT;
