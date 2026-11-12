package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;

public final class ScheduleViewDataTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";
    private static final String SCHEDULE_ID = "36ee8225-cd00-46ea-b6ef-db9e66c0946b";

    @Test
    public void preparesScheduleValuesWithoutChangingDayOrder() throws Exception {
        ScheduleViewData data = ScheduleViewData.from(schedule(
                "08:30:00",
                new JSONArray(Arrays.asList("mon", "wed", "fri")),
                45.00,
                true
        ));

        assertEquals(SCHEDULE_ID, data.scheduleId);
        assertEquals("08:30", data.time);
        assertEquals(
                Arrays.asList(
                        R.string.day_mon_short,
                        R.string.day_wed_short,
                        R.string.day_fri_short
                ),
                data.dayTextResources
        );
        assertEquals("Asia/Yekaterinburg", data.timezone);
        assertEquals("45", data.portionGrams);
        assertFalse(data.dayTextResources.isEmpty());
        assertThrows(
                UnsupportedOperationException.class,
                () -> data.dayTextResources.add(R.string.day_sun_short)
        );
    }

    @Test
    public void mapsAllContractDays() throws Exception {
        ScheduleViewData data = ScheduleViewData.from(schedule(
                "23:05:00",
                new JSONArray(Arrays.asList("mon", "tue", "wed", "thu", "fri", "sat", "sun")),
                12.50,
                false
        ));

        assertEquals("23:05", data.time);
        assertEquals(
                Arrays.asList(
                        R.string.day_mon_short,
                        R.string.day_tue_short,
                        R.string.day_wed_short,
                        R.string.day_thu_short,
                        R.string.day_fri_short,
                        R.string.day_sat_short,
                        R.string.day_sun_short
                ),
                data.dayTextResources
        );
        assertEquals("12.5", data.portionGrams);
        assertFalse(data.active);
    }

    private static Schedule schedule(
            String time,
            JSONArray days,
            double portion,
            boolean active
    ) throws Exception {
        return Schedule.parse(
                new JSONObject()
                        .put("schedule_id", SCHEDULE_ID)
                        .put("device_id", DEVICE_ID)
                        .put("time_local", time)
                        .put("days_of_week", days)
                        .put("timezone", "Asia/Yekaterinburg")
                        .put("portion_grams", portion)
                        .put("active", active)
                        .put("created_at", "2026-10-17T07:00:00Z")
                        .put("updated_at", "2026-10-17T07:00:00Z"),
                DEVICE_ID
        );
    }
}
