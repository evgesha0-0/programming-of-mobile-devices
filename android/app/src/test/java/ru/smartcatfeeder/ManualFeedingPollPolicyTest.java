package ru.smartcatfeeder;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.time.Instant;

public final class ManualFeedingPollPolicyTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";
    private static final Instant EXPIRES_AT = Instant.parse("2026-11-24T10:05:00Z");

    @Test
    public void continuesForNonTerminalFeedingWithinGracePeriod() throws Exception {
        assertTrue(ManualFeedingPollPolicy.shouldContinue(
                feeding("pending"),
                EXPIRES_AT,
                EXPIRES_AT.plusSeconds(59)
        ));
    }

    @Test
    public void stopsAtGraceDeadline() throws Exception {
        assertFalse(ManualFeedingPollPolicy.shouldContinue(
                feeding("running"),
                EXPIRES_AT,
                EXPIRES_AT.plus(ManualFeedingPollPolicy.EXPIRY_GRACE)
        ));
    }

    @Test
    public void terminalResultStopsImmediately() throws Exception {
        assertFalse(ManualFeedingPollPolicy.shouldContinue(
                feeding("completed"),
                EXPIRES_AT,
                Instant.parse("2026-11-24T10:01:00Z")
        ));
    }

    private static Feeding feeding(String status) throws Exception {
        boolean running = "running".equals(status);
        boolean completed = "completed".equals(status);
        return Feeding.parse(
                new JSONObject()
                        .put("feeding_id", "ebc2fd74-7272-4c9e-a416-bdffde906913")
                        .put("device_id", DEVICE_ID)
                        .put("schedule_id", JSONObject.NULL)
                        .put("command_id", "1875723f-f6e1-4307-92c8-81577f1ea2fb")
                        .put("source", "manual")
                        .put("portion_grams", 40.0)
                        .put("actual_grams", completed ? 39.5 : JSONObject.NULL)
                        .put("status", status)
                        .put("created_at", "2026-11-24T10:00:00Z")
                        .put("started_at", running || completed
                                ? "2026-11-24T10:00:10Z"
                                : JSONObject.NULL)
                        .put("finished_at", completed
                                ? "2026-11-24T10:00:20Z"
                                : JSONObject.NULL)
                        .put("error_code", JSONObject.NULL)
                        .put("error_message", JSONObject.NULL),
                DEVICE_ID
        );
    }
}
