package ru.smartcatfeeder;

import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.time.Instant;

public final class Feeding {
    public final String feedingId;
    public final String deviceId;
    public final String scheduleId;
    public final String commandId;
    public final Source source;
    public final BigDecimal portionGrams;
    public final BigDecimal actualGrams;
    public final Status status;
    public final Instant createdAt;
    public final Instant startedAt;
    public final Instant finishedAt;
    public final String errorCode;
    public final String errorMessage;

    private Feeding(
            String feedingId,
            String deviceId,
            String scheduleId,
            String commandId,
            Source source,
            BigDecimal portionGrams,
            BigDecimal actualGrams,
            Status status,
            Instant createdAt,
            Instant startedAt,
            Instant finishedAt,
            String errorCode,
            String errorMessage
    ) {
        this.feedingId = feedingId;
        this.deviceId = deviceId;
        this.scheduleId = scheduleId;
        this.commandId = commandId;
        this.source = source;
        this.portionGrams = portionGrams;
        this.actualGrams = actualGrams;
        this.status = status;
        this.createdAt = createdAt;
        this.startedAt = startedAt;
        this.finishedAt = finishedAt;
        this.errorCode = errorCode;
        this.errorMessage = errorMessage;
    }

    public static Feeding parse(JSONObject body, String expectedDeviceId) throws JSONException {
        String deviceId = ApiJson.requiredUuid(body, "device_id");
        ApiJson.requireExpectedId(deviceId, expectedDeviceId, "device_id");
        String scheduleId = ApiJson.nullableUuid(body, "schedule_id");
        String commandId = ApiJson.nullableUuid(body, "command_id");
        Source source = Source.fromWire(ApiJson.requiredString(body, "source"));
        Status status = Status.fromWire(ApiJson.requiredString(body, "status"));
        BigDecimal actualGrams = ApiJson.nullableNonNegativeGrams(body, "actual_grams");
        Instant startedAt = ApiJson.nullableInstant(body, "started_at");
        Instant finishedAt = ApiJson.nullableInstant(body, "finished_at");
        String errorCode = ApiJson.nullableString(body, "error_code");
        String errorMessage = ApiJson.nullableString(body, "error_message");

        validateReferences(source, scheduleId, commandId);
        validateStatus(status, actualGrams, startedAt, finishedAt, errorCode);

        return new Feeding(
                ApiJson.requiredUuid(body, "feeding_id"),
                deviceId,
                scheduleId,
                commandId,
                source,
                ApiJson.requiredPositiveGrams(body, "portion_grams"),
                actualGrams,
                status,
                ApiJson.requiredInstant(body, "created_at"),
                startedAt,
                finishedAt,
                errorCode,
                errorMessage
        );
    }

    public boolean terminal() {
        return status == Status.COMPLETED || status == Status.FAILED || status == Status.EXPIRED;
    }

    private static void validateReferences(
            Source source,
            String scheduleId,
            String commandId
    ) throws JSONException {
        if (source == Source.MANUAL && (commandId == null || scheduleId != null)) {
            throw new JSONException("manual feeding must reference only command_id");
        }
        if (source == Source.SCHEDULED && (scheduleId == null || commandId != null)) {
            throw new JSONException("scheduled feeding must reference only schedule_id");
        }
    }

    private static void validateStatus(
            Status status,
            BigDecimal actualGrams,
            Instant startedAt,
            Instant finishedAt,
            String errorCode
    ) throws JSONException {
        if (status == Status.PENDING && (startedAt != null || finishedAt != null)) {
            throw new JSONException("pending feeding cannot have execution timestamps");
        }
        if (status == Status.RUNNING && (startedAt == null || finishedAt != null)) {
            throw new JSONException("running feeding requires only started_at");
        }
        if ((status == Status.COMPLETED || status == Status.FAILED)
                && (startedAt == null || finishedAt == null)) {
            throw new JSONException("finished feeding requires execution timestamps");
        }
        if (status == Status.EXPIRED && finishedAt == null) {
            throw new JSONException("expired feeding requires finished_at");
        }
        if (status == Status.COMPLETED && actualGrams == null) {
            throw new JSONException("completed feeding requires actual_grams");
        }
        if (status == Status.FAILED && errorCode == null) {
            throw new JSONException("failed feeding requires error_code");
        }
    }

    public enum Source {
        MANUAL("manual"),
        SCHEDULED("scheduled");

        public final String wireValue;

        Source(String wireValue) {
            this.wireValue = wireValue;
        }

        private static Source fromWire(String value) throws JSONException {
            for (Source source : values()) {
                if (source.wireValue.equals(value)) {
                    return source;
                }
            }
            throw new JSONException("Unknown feeding source");
        }
    }

    public enum Status {
        PENDING("pending"),
        RUNNING("running"),
        COMPLETED("completed"),
        FAILED("failed"),
        EXPIRED("expired");

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
            throw new JSONException("Unknown feeding status");
        }
    }
}
