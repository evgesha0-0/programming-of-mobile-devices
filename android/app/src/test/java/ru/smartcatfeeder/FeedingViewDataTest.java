package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.json.JSONObject;
import org.junit.Test;

import java.time.ZoneId;

public final class FeedingViewDataTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";
    private static final String FEEDING_ID = "ebc2fd74-7272-4c9e-a416-bdffde906913";
    private static final String COMMAND_ID = "1875723f-f6e1-4307-92c8-81577f1ea2fb";

    @Test
    public void formatsCompletedManualFeeding() throws Exception {
        FeedingViewData data = FeedingViewData.from(
                feeding("manual", "completed", null),
                ZoneId.of("UTC")
        );

        assertEquals(FEEDING_ID, data.feedingId);
        assertEquals(R.string.feeding_source_manual, data.sourceTextResource);
        assertEquals(R.string.feeding_status_completed, data.statusTextResource);
        assertEquals(R.color.status_online, data.statusColorResource);
        assertEquals("17.10.2026 08:15:00", data.createdAt);
        assertEquals("40", data.portionGrams);
        assertEquals("39.5", data.actualGrams);
        assertNull(data.errorDetails);
    }

    @Test
    public void keepsFailureCodeAndMessage() throws Exception {
        FeedingViewData data = FeedingViewData.from(
                feeding("scheduled", "failed", "MOTOR_BLOCKED"),
                ZoneId.of("Europe/Moscow")
        );

        assertEquals(R.string.feeding_source_scheduled, data.sourceTextResource);
        assertEquals(R.string.feeding_status_failed, data.statusTextResource);
        assertEquals(R.color.error, data.statusColorResource);
        assertEquals("17.10.2026 11:15:00", data.createdAt);
        assertNull(data.actualGrams);
        assertEquals("MOTOR_BLOCKED — Механизм заблокирован", data.errorDetails);
    }

    @Test
    public void mapsNonTerminalAndExpiredStatuses() throws Exception {
        assertStatus("pending", R.string.feeding_status_pending, R.color.status_busy);
        assertStatus("running", R.string.feeding_status_running, R.color.status_busy);
        assertStatus("expired", R.string.feeding_status_expired, R.color.text_secondary);
    }

    private static void assertStatus(String status, int textResource, int colorResource)
            throws Exception {
        FeedingViewData data = FeedingViewData.from(
                feeding("manual", status, null),
                ZoneId.of("UTC")
        );
        assertEquals(textResource, data.statusTextResource);
        assertEquals(colorResource, data.statusColorResource);
    }

    private static Feeding feeding(String source, String status, String errorCode)
            throws Exception {
        boolean scheduled = "scheduled".equals(source);
        boolean running = "running".equals(status);
        boolean completed = "completed".equals(status);
        boolean failed = "failed".equals(status);
        boolean expired = "expired".equals(status);
        return Feeding.parse(
                new JSONObject()
                        .put("feeding_id", FEEDING_ID)
                        .put("device_id", DEVICE_ID)
                        .put("schedule_id", scheduled
                                ? "36ee8225-cd00-46ea-b6ef-db9e66c0946b"
                                : JSONObject.NULL)
                        .put("command_id", scheduled ? JSONObject.NULL : COMMAND_ID)
                        .put("source", source)
                        .put("portion_grams", 40.0)
                        .put("actual_grams", completed ? 39.5 : JSONObject.NULL)
                        .put("status", status)
                        .put("created_at", "2026-10-17T08:15:00Z")
                        .put("started_at", running || completed || failed
                                ? "2026-10-17T08:15:20Z"
                                : JSONObject.NULL)
                        .put("finished_at", completed || failed || expired
                                ? "2026-10-17T08:15:32Z"
                                : JSONObject.NULL)
                        .put("error_code", errorCode == null ? JSONObject.NULL : errorCode)
                        .put("error_message", errorCode == null
                                ? JSONObject.NULL
                                : "Механизм заблокирован"),
                DEVICE_ID
        );
    }
}
