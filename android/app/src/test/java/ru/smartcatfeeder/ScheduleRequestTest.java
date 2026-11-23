package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

import java.math.BigDecimal;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public final class ScheduleRequestTest {
    @Test
    public void createBuildsStableFullRepresentation() throws Exception {
        List<String> sourceDays = new ArrayList<>(Arrays.asList("mon", "wed", "fri"));
        ScheduleRequest request = ScheduleRequest.create(
                LocalTime.of(8, 30),
                sourceDays,
                ZoneId.of("Asia/Yekaterinburg"),
                new BigDecimal("45.00"),
                true
        );
        sourceDays.clear();

        JSONObject body = request.toJson();

        assertEquals("08:30:00", body.getString("time_local"));
        assertEquals("[\"mon\",\"wed\",\"fri\"]", body.getJSONArray("days_of_week").toString());
        assertEquals("Asia/Yekaterinburg", body.getString("timezone"));
        assertEquals(
                0,
                new BigDecimal(body.get("portion_grams").toString())
                        .compareTo(new BigDecimal("45.00"))
        );
        assertEquals(3, request.daysOfWeek.size());
        assertFalse(request.daysOfWeek == sourceDays);
    }

    @Test
    public void createRejectsInvalidContractValues() {
        assertThrows(JSONException.class, () -> ScheduleRequest.create(
                LocalTime.NOON,
                Arrays.asList("mon", "mon"),
                ZoneId.of("Europe/Moscow"),
                BigDecimal.TEN,
                true
        ));
        assertThrows(JSONException.class, () -> ScheduleRequest.create(
                LocalTime.NOON,
                Arrays.asList("mon"),
                ZoneId.of("Europe/Moscow"),
                new BigDecimal("1.001"),
                true
        ));
        assertThrows(JSONException.class, () -> ScheduleRequest.create(
                null,
                Arrays.asList("mon"),
                ZoneId.of("Europe/Moscow"),
                BigDecimal.TEN,
                true
        ));
    }
}
