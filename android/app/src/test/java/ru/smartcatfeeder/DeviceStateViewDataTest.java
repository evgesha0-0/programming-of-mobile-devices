package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.json.JSONObject;
import org.junit.Test;

import java.time.ZoneId;

public final class DeviceStateViewDataTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";

    @Test
    public void formatsOnlineStateForDisplayZone() throws Exception {
        DeviceStateViewData data = DeviceStateViewData.from(
                state("online", "2026-10-17T08:15:30Z", null),
                ZoneId.of("UTC")
        );

        assertEquals(R.string.device_status_online, data.statusTextResource);
        assertEquals(R.color.status_online, data.statusColorResource);
        assertEquals("17.10.2026 08:15:30 UTC", data.lastSeen);
        assertEquals("12", data.scheduleRevision);
        assertNull(data.errorDetails);
    }

    @Test
    public void formatsDeviceErrorWithoutLosingCode() throws Exception {
        JSONObject error = new JSONObject()
                .put("code", "MOTOR_BLOCKED")
                .put("message", "Механизм заблокирован");
        DeviceStateViewData data = DeviceStateViewData.from(
                state("error", null, error),
                ZoneId.of("Europe/Moscow")
        );

        assertEquals(R.string.device_status_error, data.statusTextResource);
        assertEquals(R.color.error, data.statusColorResource);
        assertNull(data.lastSeen);
        assertEquals("MOTOR_BLOCKED — Механизм заблокирован", data.errorDetails);
    }

    @Test
    public void mapsEveryBackendStatusToUiResources() throws Exception {
        assertStatus("busy", R.string.device_status_busy, R.color.status_busy);
        assertStatus("offline", R.string.device_status_offline, R.color.text_secondary);
        assertStatus("unknown", R.string.device_status_unknown, R.color.text_secondary);
    }

    private static void assertStatus(String status, int textResource, int colorResource)
            throws Exception {
        DeviceStateViewData data = DeviceStateViewData.from(
                state(status, null, null),
                ZoneId.of("UTC")
        );
        assertEquals(textResource, data.statusTextResource);
        assertEquals(colorResource, data.statusColorResource);
    }

    private static DeviceState state(String status, String lastSeenAt, JSONObject error)
            throws Exception {
        return DeviceState.parse(
                new JSONObject()
                        .put("device_id", DEVICE_ID)
                        .put("status", status)
                        .put("last_seen_at", lastSeenAt == null ? JSONObject.NULL : lastSeenAt)
                        .put("last_error", error == null ? JSONObject.NULL : error)
                        .put("schedule_revision", 12),
                DEVICE_ID
        );
    }
}
