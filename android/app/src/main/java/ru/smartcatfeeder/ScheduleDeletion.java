package ru.smartcatfeeder;

import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;

/** Подтверждение мягкого удаления расписания. */
public final class ScheduleDeletion {
    public final String scheduleId;
    public final long scheduleRevision;
    public final Instant deletedAt;

    private ScheduleDeletion(String scheduleId, long scheduleRevision, Instant deletedAt) {
        this.scheduleId = scheduleId;
        this.scheduleRevision = scheduleRevision;
        this.deletedAt = deletedAt;
    }

    public static ScheduleDeletion parse(JSONObject body, String expectedScheduleId)
            throws JSONException {
        String scheduleId = ApiJson.requiredUuid(body, "schedule_id");
        ApiJson.requireExpectedId(scheduleId, expectedScheduleId, "schedule_id");
        if (!ApiJson.requiredBoolean(body, "deleted")) {
            throw new JSONException("Schedule was not deleted");
        }
        return new ScheduleDeletion(
                scheduleId,
                ApiJson.requiredNonNegativeLong(body, "schedule_revision"),
                ApiJson.requiredInstant(body, "deleted_at")
        );
    }
}
