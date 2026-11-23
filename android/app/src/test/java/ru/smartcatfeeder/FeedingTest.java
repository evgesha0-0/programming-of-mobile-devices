package ru.smartcatfeeder;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

import java.math.BigDecimal;
import java.time.Instant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public final class FeedingTest {
    static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";
    static final String FEEDING_ID = "ebc2fd74-7272-4c9e-a416-bdffde906913";
    static final String COMMAND_ID = "1875723f-f6e1-4307-92c8-81577f1ea2fb";
    static final String SCHEDULE_ID = "36ee8225-cd00-46ea-b6ef-db9e66c0946b";

    @Test
    public void parsesCompletedManualFeeding() throws Exception {
        Feeding feeding = Feeding.parse(completedManual(), DEVICE_ID);

        assertEquals(FEEDING_ID, feeding.feedingId);
        assertEquals(COMMAND_ID, feeding.commandId);
        assertNull(feeding.scheduleId);
        assertEquals(Feeding.Source.MANUAL, feeding.source);
        assertEquals(Feeding.Status.COMPLETED, feeding.status);
        assertEquals(new BigDecimal("39.50"), feeding.actualGrams);
        assertEquals(Instant.parse("2026-10-17T08:15:32Z"), feeding.finishedAt);
        assertTrue(feeding.terminal());
    }

    @Test
    public void parsesFailedScheduledFeeding() throws Exception {
        JSONObject body = completedManual()
                .put("schedule_id", SCHEDULE_ID)
                .put("command_id", JSONObject.NULL)
                .put("source", "scheduled")
                .put("status", "failed")
                .put("actual_grams", JSONObject.NULL)
                .put("error_code", "MOTOR_ERROR")
                .put("error_message", "Механизм заблокирован");

        Feeding feeding = Feeding.parse(body, DEVICE_ID);

        assertEquals(Feeding.Source.SCHEDULED, feeding.source);
        assertEquals("MOTOR_ERROR", feeding.errorCode);
        assertNull(feeding.actualGrams);
        assertTrue(feeding.terminal());
    }

    @Test
    public void rejectsInconsistentSourceAndTerminalState() throws Exception {
        JSONObject wrongSource = completedManual().put("source", "scheduled");
        assertThrows(JSONException.class, () -> Feeding.parse(wrongSource, DEVICE_ID));

        JSONObject completedWithoutMass = completedManual().put("actual_grams", JSONObject.NULL);
        assertThrows(
                JSONException.class,
                () -> Feeding.parse(completedWithoutMass, DEVICE_ID)
        );

        JSONObject failedWithoutCode = completedManual()
                .put("status", "failed")
                .put("error_code", JSONObject.NULL);
        assertThrows(
                JSONException.class,
                () -> Feeding.parse(failedWithoutCode, DEVICE_ID)
        );

        JSONObject pendingWithFinishedAt = completedManual()
                .put("status", "pending")
                .put("started_at", JSONObject.NULL)
                .put("finished_at", "2026-10-17T08:15:32Z");
        assertThrows(
                JSONException.class,
                () -> Feeding.parse(pendingWithFinishedAt, DEVICE_ID)
        );
    }

    @Test
    public void parsesHistoryPageAndRejectsDuplicates() throws Exception {
        JSONObject body = new JSONObject()
                .put("items", new JSONArray().put(completedManual()))
                .put("next_cursor", "opaque-cursor");

        FeedingHistoryPage page = FeedingHistoryPage.parse(body, DEVICE_ID);

        assertEquals(1, page.items.size());
        assertEquals("opaque-cursor", page.nextCursor);
        assertThrows(UnsupportedOperationException.class, () -> page.items.clear());

        body.put("items", new JSONArray().put(completedManual()).put(completedManual()));
        assertThrows(
                JSONException.class,
                () -> FeedingHistoryPage.parse(body, DEVICE_ID)
        );
    }

    static JSONObject completedManual() throws JSONException {
        return new JSONObject()
                .put("feeding_id", FEEDING_ID)
                .put("device_id", DEVICE_ID)
                .put("schedule_id", JSONObject.NULL)
                .put("command_id", COMMAND_ID)
                .put("source", "manual")
                .put("portion_grams", new BigDecimal("40.00"))
                .put("actual_grams", new BigDecimal("39.50"))
                .put("status", "completed")
                .put("created_at", "2026-10-17T08:15:00Z")
                .put("started_at", "2026-10-17T08:15:20Z")
                .put("finished_at", "2026-10-17T08:15:32Z")
                .put("error_code", JSONObject.NULL)
                .put("error_message", JSONObject.NULL);
    }
}
