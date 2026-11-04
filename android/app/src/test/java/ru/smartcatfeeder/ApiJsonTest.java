package ru.smartcatfeeder;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

import java.math.BigDecimal;
import java.time.LocalTime;
import java.time.ZoneId;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public final class ApiJsonTest {
    @Test
    public void validatesNumericContractWithoutLosingPrecision() throws Exception {
        JSONObject body = new JSONObject()
                .put("portion", new BigDecimal("999999.99"))
                .put("actual", new BigDecimal("0.00"));

        assertEquals(
                new BigDecimal("999999.99"),
                ApiJson.requiredPositiveGrams(body, "portion")
        );
        assertEquals(
                new BigDecimal("0.00"),
                ApiJson.nullableNonNegativeGrams(body, "actual")
        );

        for (Object invalid : new Object[]{"40", 0, -1, 1.001, 1_000_000}) {
            body.put("portion", invalid);
            assertThrows(
                    JSONException.class,
                    () -> ApiJson.requiredPositiveGrams(body, "portion")
            );
        }
    }

    @Test
    public void validatesScheduleTimeZoneAndUniqueDays() throws Exception {
        JSONObject body = new JSONObject()
                .put("time", "08:30:00")
                .put("timezone", "Europe/Moscow")
                .put("days", new JSONArray().put("mon").put("wed").put("fri"));

        assertEquals(LocalTime.of(8, 30), ApiJson.requiredLocalTime(body, "time"));
        assertEquals(ZoneId.of("Europe/Moscow"), ApiJson.requiredZoneId(body, "timezone"));
        assertEquals(3, ApiJson.requiredDays(body, "days").size());

        body.put("time", "8:30");
        assertThrows(JSONException.class, () -> ApiJson.requiredLocalTime(body, "time"));
        body.put("timezone", "Unknown/Zone");
        assertThrows(JSONException.class, () -> ApiJson.requiredZoneId(body, "timezone"));
        body.put("days", new JSONArray().put("mon").put("mon"));
        assertThrows(JSONException.class, () -> ApiJson.requiredDays(body, "days"));
    }

    @Test
    public void rejectsNonCanonicalUuidAndFractionalRevision() throws Exception {
        JSONObject body = new JSONObject()
                .put("id", "not-a-uuid")
                .put("revision", 1.5);

        assertThrows(JSONException.class, () -> ApiJson.requiredUuid(body, "id"));
        assertThrows(
                JSONException.class,
                () -> ApiJson.requiredNonNegativeLong(body, "revision")
        );
    }
}
