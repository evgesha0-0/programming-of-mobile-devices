CREATE TABLE user_credentials (
    credential_id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    token_hash bytea NOT NULL UNIQUE,
    token_hint varchar(12) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at timestamptz,
    CONSTRAINT user_credentials_token_hash_length_check
        CHECK (octet_length(token_hash) = 32),
    CONSTRAINT user_credentials_token_hint_check
        CHECK (token_hint = encode(substring(token_hash FROM 1 FOR 6), 'hex')),
    CONSTRAINT user_credentials_last_used_check
        CHECK (last_used_at IS NULL OR last_used_at >= created_at),
    CONSTRAINT user_credentials_revoked_check
        CHECK (revoked_at IS NULL OR revoked_at >= created_at),
    CONSTRAINT user_credentials_usage_before_revocation_check
        CHECK (last_used_at IS NULL OR revoked_at IS NULL OR last_used_at <= revoked_at)
);

CREATE UNIQUE INDEX user_credentials_one_active_per_user_idx
    ON user_credentials (user_id)
    WHERE revoked_at IS NULL;

CREATE INDEX user_credentials_user_history_idx
    ON user_credentials (user_id, created_at DESC);

CREATE FUNCTION feeder_protect_user_credential()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(NEW.credential_id, NEW.user_id, NEW.token_hash, NEW.token_hint, NEW.created_at)
        IS DISTINCT FROM
        ROW(OLD.credential_id, OLD.user_id, OLD.token_hash, OLD.token_hint, OLD.created_at) THEN
        RAISE EXCEPTION 'User credential identity cannot be changed'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'Revoked user credential cannot be restored or changed'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.revoked_at IS NOT NULL AND NEW.last_used_at IS DISTINCT FROM OLD.last_used_at THEN
        RAISE EXCEPTION 'Revoked user credential cannot be used'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.last_used_at IS NOT NULL
        AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at) THEN
        RAISE EXCEPTION 'User credential last_used_at cannot move backwards'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER user_credentials_protect_update
BEFORE UPDATE ON user_credentials
FOR EACH ROW
EXECUTE FUNCTION feeder_protect_user_credential();
