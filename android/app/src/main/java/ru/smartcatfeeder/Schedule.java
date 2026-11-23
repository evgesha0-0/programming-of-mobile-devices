package ru.smartcatfeeder;

import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.List;

public final class Schedule {
    public final String scheduleId;
    public final String deviceId;
    public final LocalTime timeLocal;
    public final List<String> daysOfWeek;
    public final ZoneId timezone;
    public final BigDecimal portionGrams;
    public final boolean active;
    public final Long scheduleRevision;
    public final Instant createdAt;
    public final Instant updatedAt;

    private Schedule(
            String scheduleId,
            String deviceId,
            LocalTime timeLocal,
            List<String> daysOfWeek,
            ZoneId timezone,
            BigDecimal portionGrams,
            boolean active,
            Long scheduleRevision,
            Instant createdAt,
            Instant updatedAt
    ) {
        this.scheduleId = scheduleId;
        this.deviceId = deviceId;
        this.timeLocal = timeLocal;
        this.daysOfWeek = daysOfWeek;
        this.timezone = timezone;
        this.portionGrams = portionGrams;
        this.active = active;
        this.scheduleRevision = scheduleRevision;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    public static Schedule parse(JSONObject body, String expectedDeviceId) throws JSONException {
        String deviceId = expectedDeviceId;
        if (body.has("device_id") && !body.isNull("device_id")) {
            deviceId = ApiJson.requiredUuid(body, "device_id");
            ApiJson.requireExpectedId(deviceId, expectedDeviceId, "device_id");
        }
        Long revision = body.has("schedule_revision") && !body.isNull("schedule_revision")
                ? ApiJson.requiredNonNegativeLong(body, "schedule_revision")
                : null;
        return new Schedule(
                ApiJson.requiredUuid(body, "schedule_id"),
                deviceId,
                ApiJson.requiredLocalTime(body, "time_local"),
                ApiJson.requiredDays(body, "days_of_week"),
                ApiJson.requiredZoneId(body, "timezone"),
                ApiJson.requiredPositiveGrams(body, "portion_grams"),
                ApiJson.requiredBoolean(body, "active"),
                revision,
                ApiJson.requiredInstant(body, "created_at"),
                ApiJson.requiredInstant(body, "updated_at")
        );
    }
}
