package ru.smartcatfeeder;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

import java.math.BigDecimal;
import java.time.LocalTime;
import java.time.ZoneId;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

public final class ScheduleTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";
    private static final String SCHEDULE_ID = "36ee8225-cd00-46ea-b6ef-db9e66c0946b";

    @Test
    public void parsesScheduleListSnapshot() throws Exception {
        JSONObject body = new JSONObject()
                .put("device_id", DEVICE_ID)
                .put("schedule_revision", 12)
                .put("items", new JSONArray().put(validSchedule()));

        ScheduleList result = ScheduleList.parse(body, DEVICE_ID);
        Schedule schedule = result.items.get(0);

        assertEquals(DEVICE_ID, result.deviceId);
        assertEquals(12, result.scheduleRevision);
        assertEquals(SCHEDULE_ID, schedule.scheduleId);
        assertEquals(LocalTime.of(8, 30), schedule.timeLocal);
        assertEquals(ZoneId.of("Asia/Yekaterinburg"), schedule.timezone);
        assertEquals(new BigDecimal("45.0"), schedule.portionGrams);
        assertEquals(3, schedule.daysOfWeek.size());
        assertNull(schedule.scheduleRevision);
        assertThrows(UnsupportedOperationException.class, () -> result.items.clear());
        assertThrows(UnsupportedOperationException.class, () -> schedule.daysOfWeek.clear());
    }

    @Test
    public void parsesCreateOrUpdateResponseWithRevision() throws Exception {
        JSONObject body = validSchedule()
                .put("device_id", DEVICE_ID)
                .put("schedule_revision", 13);

        Schedule schedule = Schedule.parse(body, DEVICE_ID);

        assertEquals(Long.valueOf(13), schedule.scheduleRevision);
        assertEquals(DEVICE_ID, schedule.deviceId);
    }

    @Test
    public void rejectsMalformedScheduleAndDuplicateIdentifiers() throws Exception {
        JSONObject invalidTime = validSchedule().put("time_local", "25:00:00");
        assertThrows(JSONException.class, () -> Schedule.parse(invalidTime, DEVICE_ID));

        JSONObject invalidZone = validSchedule().put("timezone", "UTC+5");
        assertThrows(JSONException.class, () -> Schedule.parse(invalidZone, DEVICE_ID));

        JSONObject duplicateDays = validSchedule().put(
                "days_of_week",
                new JSONArray().put("mon").put("mon")
        );
        assertThrows(JSONException.class, () -> Schedule.parse(duplicateDays, DEVICE_ID));

        JSONObject duplicateItems = new JSONObject()
                .put("device_id", DEVICE_ID)
                .put("schedule_revision", 12)
                .put("items", new JSONArray().put(validSchedule()).put(validSchedule()));
        assertThrows(JSONException.class, () -> ScheduleList.parse(duplicateItems, DEVICE_ID));
    }

    private static JSONObject validSchedule() throws JSONException {
        return new JSONObject()
                .put("schedule_id", SCHEDULE_ID)
                .put("time_local", "08:30:00")
                .put("days_of_week", new JSONArray().put("mon").put("wed").put("fri"))
                .put("timezone", "Asia/Yekaterinburg")
                .put("portion_grams", new BigDecimal("45.0"))
                .put("active", true)
                .put("created_at", "2026-10-16T12:00:00Z")
                .put("updated_at", "2026-10-17T07:00:00Z");
    }
}
