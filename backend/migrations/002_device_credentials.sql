CREATE TABLE device_credentials (
    credential_id uuid PRIMARY KEY,
    device_id uuid NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
    token_hash bytea NOT NULL UNIQUE,
    token_hint varchar(12) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at timestamptz,
    CONSTRAINT device_credentials_token_hash_length_check
        CHECK (octet_length(token_hash) = 32),
    CONSTRAINT device_credentials_token_hint_check
        CHECK (token_hint = encode(substring(token_hash FROM 1 FOR 6), 'hex')),
    CONSTRAINT device_credentials_last_used_check
        CHECK (last_used_at IS NULL OR last_used_at >= created_at),
    CONSTRAINT device_credentials_revoked_check
        CHECK (revoked_at IS NULL OR revoked_at >= created_at),
    CONSTRAINT device_credentials_usage_before_revocation_check
        CHECK (last_used_at IS NULL OR revoked_at IS NULL OR last_used_at <= revoked_at)
);

CREATE UNIQUE INDEX device_credentials_one_active_per_device_idx
    ON device_credentials (device_id)
    WHERE revoked_at IS NULL;

CREATE INDEX device_credentials_device_history_idx
    ON device_credentials (device_id, created_at DESC);

CREATE FUNCTION feeder_protect_device_credential()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(NEW.credential_id, NEW.device_id, NEW.token_hash, NEW.token_hint, NEW.created_at)
        IS DISTINCT FROM
        ROW(OLD.credential_id, OLD.device_id, OLD.token_hash, OLD.token_hint, OLD.created_at) THEN
        RAISE EXCEPTION 'Device credential identity cannot be changed'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'Revoked device credential cannot be restored or changed'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.revoked_at IS NOT NULL AND NEW.last_used_at IS DISTINCT FROM OLD.last_used_at THEN
        RAISE EXCEPTION 'Revoked device credential cannot be used'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.last_used_at IS NOT NULL
        AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at) THEN
        RAISE EXCEPTION 'Device credential last_used_at cannot move backwards'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER device_credentials_protect_update
BEFORE UPDATE ON device_credentials
FOR EACH ROW
EXECUTE FUNCTION feeder_protect_device_credential();
