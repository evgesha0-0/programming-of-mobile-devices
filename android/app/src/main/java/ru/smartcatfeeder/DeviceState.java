package ru.smartcatfeeder;

import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;

public final class DeviceState {
    public final String deviceId;
    public final Status status;
    public final Instant lastSeenAt;
    public final DeviceError lastError;
    public final long scheduleRevision;

    private DeviceState(
            String deviceId,
            Status status,
            Instant lastSeenAt,
            DeviceError lastError,
            long scheduleRevision
    ) {
        this.deviceId = deviceId;
        this.status = status;
        this.lastSeenAt = lastSeenAt;
        this.lastError = lastError;
        this.scheduleRevision = scheduleRevision;
    }

    public static DeviceState parse(JSONObject body, String expectedDeviceId) throws JSONException {
        String deviceId = ApiJson.requiredUuid(body, "device_id");
        ApiJson.requireExpectedId(deviceId, expectedDeviceId, "device_id");
        Status status = Status.fromWire(ApiJson.requiredString(body, "status"));
        Instant lastSeenAt = ApiJson.nullableInstant(body, "last_seen_at");
        DeviceError lastError = parseLastError(body);
        long revision = ApiJson.requiredNonNegativeLong(body, "schedule_revision");
        return new DeviceState(deviceId, status, lastSeenAt, lastError, revision);
    }

    private static DeviceError parseLastError(JSONObject body) throws JSONException {
        if (!body.has("last_error") || body.isNull("last_error")) {
            return null;
        }
        JSONObject error = ApiJson.requiredObject(body, "last_error");
        return new DeviceError(
                ApiJson.requiredString(error, "code"),
                ApiJson.nullableString(error, "message")
        );
    }

    public enum Status {
        ONLINE("online"),
        BUSY("busy"),
        ERROR("error"),
        OFFLINE("offline"),
        UNKNOWN("unknown");

        public final String wireValue;

        Status(String wireValue) {
            this.wireValue = wireValue;
        }

        private static Status fromWire(String value) throws JSONException {
            for (Status status : values()) {
                if (status.wireValue.equals(value)) {
                    return status;
                }
            }
            throw new JSONException("Unknown device status");
        }
    }

    public static final class DeviceError {
        public final String code;
        public final String message;

        private DeviceError(String code, String message) {
            this.code = code;
            this.message = message;
        }
    }
}
