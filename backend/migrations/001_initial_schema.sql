CREATE FUNCTION feeder_valid_days(days text[])
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT cardinality(days) BETWEEN 1 AND 7
        AND array_ndims(days) = 1
        AND array_position(days, NULL) IS NULL
        AND days <@ ARRAY['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']::text[]
        AND cardinality(days) = (SELECT count(DISTINCT day) FROM unnest(days) AS day);
$$;

CREATE TABLE devices (
    device_id uuid PRIMARY KEY,
    name varchar(100) NOT NULL CHECK (length(btrim(name)) > 0),
    status varchar(32) NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('online', 'busy', 'error', 'offline', 'unknown')),
    firmware_version varchar(64),
    last_seen_at timestamptz,
    schedule_revision bigint NOT NULL DEFAULT 0 CHECK (schedule_revision >= 0),
    last_error_code varchar(64),
    last_error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schedules (
    schedule_id uuid PRIMARY KEY,
    device_id uuid NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
    time_local time(0) NOT NULL CHECK (time_local < time '24:00:00'),
    days_of_week varchar(3)[] NOT NULL CHECK (feeder_valid_days(days_of_week::text[])),
    timezone varchar(64) NOT NULL CHECK (length(btrim(timezone)) > 0),
    portion_grams numeric(8,2) NOT NULL CHECK (portion_grams > 0 AND portion_grams <> 'NaN'::numeric),
    active boolean NOT NULL DEFAULT true,
    revision bigint NOT NULL CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (device_id, revision),
    UNIQUE (device_id, schedule_id)
);

CREATE TABLE feeding_commands (
    command_id uuid PRIMARY KEY,
    feeding_id uuid NOT NULL UNIQUE,
    device_id uuid NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
    portion_grams numeric(8,2) NOT NULL CHECK (portion_grams > 0 AND portion_grams <> 'NaN'::numeric),
    status varchar(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'expired')),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    error_code varchar(64),
    CHECK (expires_at > created_at),
    CHECK (status NOT IN ('running', 'completed', 'failed') OR started_at IS NOT NULL),
    CHECK (status NOT IN ('completed', 'failed', 'expired') OR finished_at IS NOT NULL),
    CHECK (started_at IS NULL OR started_at >= created_at),
    CHECK (finished_at IS NULL OR finished_at >= COALESCE(started_at, created_at)),
    UNIQUE (device_id, command_id, feeding_id)
);

CREATE FUNCTION feeder_command_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.command_id, NEW.feeding_id, NEW.device_id, NEW.portion_grams, NEW.created_at, NEW.expires_at)
       IS DISTINCT FROM
       ROW(OLD.command_id, OLD.feeding_id, OLD.device_id, OLD.portion_grams, OLD.created_at, OLD.expires_at) THEN
        RAISE EXCEPTION 'Manual command identity and payload cannot be changed' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
        (OLD.status = 'pending' AND NEW.status IN ('running', 'expired'))
        OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed'))
    ) THEN
        RAISE EXCEPTION 'Invalid manual command status transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER feeding_command_transition
BEFORE UPDATE ON feeding_commands
FOR EACH ROW EXECUTE FUNCTION feeder_command_transition();

CREATE TABLE feedings (
    feeding_id uuid PRIMARY KEY,
    device_id uuid NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
    schedule_id uuid,
    command_id uuid UNIQUE,
    source varchar(16) NOT NULL CHECK (source IN ('manual', 'scheduled')),
    portion_grams numeric(8,2) NOT NULL CHECK (portion_grams > 0 AND portion_grams <> 'NaN'::numeric),
    actual_grams numeric(8,2) CHECK (actual_grams >= 0 AND actual_grams <> 'NaN'::numeric),
    status varchar(16) NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'expired')),
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    error_code varchar(64),
    error_message text,
    received_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((source = 'manual' AND command_id IS NOT NULL AND schedule_id IS NULL)
        OR (source = 'scheduled' AND schedule_id IS NOT NULL AND command_id IS NULL)),
    CHECK (status NOT IN ('completed', 'failed') OR finished_at IS NOT NULL),
    CHECK (status <> 'completed' OR actual_grams IS NOT NULL),
    CHECK (started_at IS NULL OR started_at >= created_at),
    CHECK (finished_at IS NULL OR finished_at >= COALESCE(started_at, created_at)),
    FOREIGN KEY (device_id, schedule_id) REFERENCES schedules(device_id, schedule_id) ON DELETE RESTRICT,
    FOREIGN KEY (device_id, command_id, feeding_id)
        REFERENCES feeding_commands(device_id, command_id, feeding_id) ON DELETE RESTRICT
);

CREATE INDEX schedules_device_active_idx ON schedules(device_id) WHERE deleted_at IS NULL;
CREATE INDEX commands_pending_idx ON feeding_commands(device_id, created_at, command_id) WHERE status = 'pending';
CREATE INDEX feedings_history_idx ON feedings(device_id, created_at DESC, feeding_id DESC);
