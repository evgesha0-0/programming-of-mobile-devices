CREATE TABLE users (
    user_id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    disabled_at timestamptz,
    CONSTRAINT users_disabled_at_check
        CHECK (disabled_at IS NULL OR disabled_at >= created_at)
);

CREATE TABLE user_identities (
    identity_id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    issuer varchar(2048) NOT NULL,
    subject varchar(255) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,
    CONSTRAINT user_identities_issuer_check
        CHECK (issuer = btrim(issuer) AND length(issuer) > 0),
    CONSTRAINT user_identities_subject_check
        CHECK (subject = btrim(subject) AND length(subject) > 0),
    CONSTRAINT user_identities_last_seen_at_check
        CHECK (last_seen_at IS NULL OR last_seen_at >= created_at),
    CONSTRAINT user_identities_provider_subject_unique
        UNIQUE (issuer, subject),
    CONSTRAINT user_identities_user_provider_unique
        UNIQUE (user_id, issuer)
);

CREATE INDEX user_identities_user_idx
    ON user_identities (user_id);

CREATE TABLE user_devices (
    user_device_id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    device_id uuid NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
    role varchar(16) NOT NULL,
    linked_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    CONSTRAINT user_devices_role_check
        CHECK (role IN ('owner', 'viewer')),
    CONSTRAINT user_devices_revoked_at_check
        CHECK (revoked_at IS NULL OR revoked_at >= linked_at)
);

CREATE UNIQUE INDEX user_devices_one_active_link_idx
    ON user_devices (user_id, device_id)
    WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX user_devices_one_active_owner_idx
    ON user_devices (device_id)
    WHERE role = 'owner' AND revoked_at IS NULL;

CREATE INDEX user_devices_active_by_device_idx
    ON user_devices (device_id, user_id)
    WHERE revoked_at IS NULL;

CREATE INDEX user_devices_history_by_user_idx
    ON user_devices (user_id, linked_at DESC);

CREATE FUNCTION feeder_protect_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(NEW.user_id, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.user_id, OLD.created_at) THEN
        RAISE EXCEPTION 'User identity cannot be changed'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at THEN
        RAISE EXCEPTION 'Disabled user cannot be restored or changed'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER users_protect_update
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION feeder_protect_user();

CREATE FUNCTION feeder_protect_user_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(NEW.identity_id, NEW.user_id, NEW.issuer, NEW.subject, NEW.created_at)
        IS DISTINCT FROM
        ROW(OLD.identity_id, OLD.user_id, OLD.issuer, OLD.subject, OLD.created_at) THEN
        RAISE EXCEPTION 'External user identity cannot be changed'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.last_seen_at IS NOT NULL
        AND (NEW.last_seen_at IS NULL OR NEW.last_seen_at < OLD.last_seen_at) THEN
        RAISE EXCEPTION 'User identity last_seen_at cannot move backwards'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER user_identities_protect_update
BEFORE UPDATE ON user_identities
FOR EACH ROW
EXECUTE FUNCTION feeder_protect_user_identity();

CREATE FUNCTION feeder_protect_user_device()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(NEW.user_device_id, NEW.user_id, NEW.device_id, NEW.role, NEW.linked_at)
        IS DISTINCT FROM
        ROW(OLD.user_device_id, OLD.user_id, OLD.device_id, OLD.role, OLD.linked_at) THEN
        RAISE EXCEPTION 'User device access identity cannot be changed'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'Revoked user device access cannot be restored or changed'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER user_devices_protect_update
BEFORE UPDATE ON user_devices
FOR EACH ROW
EXECUTE FUNCTION feeder_protect_user_device();
