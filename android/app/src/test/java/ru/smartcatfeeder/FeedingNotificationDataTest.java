package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public final class FeedingNotificationDataTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";

    @Test
    public void completedNotificationContainsOnlyMeasuredResult() throws Exception {
        FeedingNotificationData data = FeedingNotificationData.from(feeding("completed"));

        assertTrue(data.notificationId > 0);
        assertEquals(R.string.notification_feeding_completed_title, data.titleResource);
        assertEquals(R.string.notification_feeding_completed_body, data.bodyResource);
        assertEquals("39.5", data.bodyArgument);
    }

    @Test
    public void failedAndExpiredNotificationsUseSafeDetails() throws Exception {
        FeedingNotificationData failed = FeedingNotificationData.from(feeding("failed"));
        FeedingNotificationData expired = FeedingNotificationData.from(feeding("expired"));

        assertEquals(R.string.notification_feeding_failed_title, failed.titleResource);
        assertEquals("Механизм заблокирован", failed.bodyArgument);
        assertEquals(R.string.notification_feeding_expired_title, expired.titleResource);
        assertNull(expired.bodyArgument);
    }

    @Test
    public void nonTerminalFeedingCannotCreateNotification() throws Exception {
        assertThrows(
                IllegalArgumentException.class,
                () -> FeedingNotificationData.from(feeding("pending"))
        );
        assertThrows(
                IllegalArgumentException.class,
                () -> FeedingNotificationData.from(feeding("running"))
        );
    }

    private static Feeding feeding(String status) throws Exception {
        boolean running = "running".equals(status);
        boolean completed = "completed".equals(status);
        boolean failed = "failed".equals(status);
        boolean expired = "expired".equals(status);
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
                        .put("started_at", running || completed || failed
                                ? "2026-11-24T10:00:10Z"
                                : JSONObject.NULL)
                        .put("finished_at", completed || failed || expired
                                ? "2026-11-24T10:00:20Z"
                                : JSONObject.NULL)
                        .put("error_code", failed ? "MOTOR_BLOCKED" : JSONObject.NULL)
                        .put("error_message", failed
                                ? "Механизм заблокирован"
                                : JSONObject.NULL),
                DEVICE_ID
        );
    }
}
