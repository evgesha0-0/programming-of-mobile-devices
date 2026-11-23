CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE schedules (
  schedule_id TEXT PRIMARY KEY,
  time_local TEXT NOT NULL,
  days_of_week_json TEXT NOT NULL CHECK (json_valid(days_of_week_json)),
  timezone TEXT NOT NULL,
  portion_grams_cents INTEGER NOT NULL CHECK (portion_grams_cents > 0),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  snapshot_revision INTEGER NOT NULL CHECK (snapshot_revision >= 0)
) STRICT;

CREATE INDEX schedules_active_idx ON schedules(active, deleted_at);

CREATE TABLE schedule_occurrences (
  occurrence_key TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  feeding_id TEXT NOT NULL UNIQUE,
  scheduled_for TEXT NOT NULL,
  claimed_at TEXT NOT NULL
) STRICT;

CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  feeding_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  expires_at TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (
    'received', 'ack_intent', 'acked', 'actuation_intent', 'terminal', 'quarantined'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE feedings (
  feeding_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('manual', 'scheduled')),
  command_id TEXT UNIQUE,
  schedule_id TEXT,
  portion_grams_cents INTEGER NOT NULL CHECK (portion_grams_cents > 0),
  actual_grams_cents INTEGER CHECK (actual_grams_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'expired')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  terminal_payload_json TEXT CHECK (
    terminal_payload_json IS NULL OR json_valid(terminal_payload_json)
  ),
  CHECK (
    (source = 'manual' AND command_id IS NOT NULL AND schedule_id IS NULL)
    OR (source = 'scheduled' AND schedule_id IS NOT NULL AND command_id IS NULL)
  ),
  CHECK (status <> 'completed' OR actual_grams_cents IS NOT NULL),
  CHECK (status NOT IN ('completed', 'failed') OR finished_at IS NOT NULL)
) STRICT;

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('state', 'ack', 'manual_result', 'scheduled_event')),
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (kind, aggregate_id)
) STRICT;

CREATE INDEX outbox_pending_idx ON outbox(delivered_at, next_attempt_at, id);

CREATE TABLE device_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  status TEXT NOT NULL CHECK (status IN ('online', 'busy', 'error', 'unknown')),
  reported_at TEXT NOT NULL,
  firmware_version TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT
) STRICT;

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  aggregate_id TEXT,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE sim_world (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  updated_at TEXT NOT NULL
) STRICT;
