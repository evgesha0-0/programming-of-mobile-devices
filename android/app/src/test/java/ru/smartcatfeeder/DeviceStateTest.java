package ru.smartcatfeeder;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

import java.time.Instant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

public final class DeviceStateTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";

    @Test
    public void parsesStateAndOptionalDeviceError() throws Exception {
        JSONObject body = validBody().put("last_error", new JSONObject()
                .put("code", "WEIGHT_SENSOR_ERROR")
                .put("message", "Датчик временно недоступен"));

        DeviceState state = DeviceState.parse(body, DEVICE_ID);

        assertEquals(DEVICE_ID, state.deviceId);
        assertEquals(DeviceState.Status.ONLINE, state.status);
        assertEquals(Instant.parse("2026-10-17T08:15:30Z"), state.lastSeenAt);
        assertEquals(12, state.scheduleRevision);
        assertNotNull(state.lastError);
        assertEquals("WEIGHT_SENSOR_ERROR", state.lastError.code);
    }

    @Test
    public void acceptsUnknownDeviceWithoutLastSeenTimestamp() throws Exception {
        JSONObject body = validBody()
                .put("status", "unknown")
                .put("last_seen_at", JSONObject.NULL)
                .put("last_error", JSONObject.NULL);

        DeviceState state = DeviceState.parse(body, DEVICE_ID);

        assertEquals(DeviceState.Status.UNKNOWN, state.status);
        assertNull(state.lastSeenAt);
        assertNull(state.lastError);
    }

    @Test
    public void rejectsForeignDeviceUnknownStatusAndInvalidTimestamp() throws Exception {
        JSONObject foreign = validBody().put(
                "device_id",
                "ebc2fd74-7272-4c9e-a416-bdffde906913"
        );
        assertThrows(JSONException.class, () -> DeviceState.parse(foreign, DEVICE_ID));

        JSONObject unknownStatus = validBody().put("status", "connected");
        assertThrows(JSONException.class, () -> DeviceState.parse(unknownStatus, DEVICE_ID));

        JSONObject invalidTime = validBody().put("last_seen_at", "17.10.2026 08:15");
        assertThrows(JSONException.class, () -> DeviceState.parse(invalidTime, DEVICE_ID));

        JSONObject invalidRevision = validBody().put("schedule_revision", -1);
        assertThrows(JSONException.class, () -> DeviceState.parse(invalidRevision, DEVICE_ID));
    }

    private static JSONObject validBody() throws JSONException {
        return new JSONObject()
                .put("device_id", DEVICE_ID)
                .put("status", "online")
                .put("last_seen_at", "2026-10-17T08:15:30Z")
                .put("last_error", JSONObject.NULL)
                .put("schedule_revision", 12);
    }
}
