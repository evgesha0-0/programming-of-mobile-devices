package ru.smartcatfeeder;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;

/** Полное изменяемое представление расписания для POST и PUT. */
public final class ScheduleRequest {
    private static final DateTimeFormatter WIRE_TIME =
            DateTimeFormatter.ofPattern("HH:mm:ss", Locale.ROOT);

    public final LocalTime timeLocal;
    public final List<String> daysOfWeek;
    public final ZoneId timezone;
    public final BigDecimal portionGrams;
    public final boolean active;

    private ScheduleRequest(
            LocalTime timeLocal,
            List<String> daysOfWeek,
            ZoneId timezone,
            BigDecimal portionGrams,
            boolean active
    ) {
        this.timeLocal = timeLocal;
        this.daysOfWeek = daysOfWeek;
        this.timezone = timezone;
        this.portionGrams = portionGrams;
        this.active = active;
    }

    public static ScheduleRequest create(
            LocalTime timeLocal,
            List<String> daysOfWeek,
            ZoneId timezone,
            BigDecimal portionGrams,
            boolean active
    ) throws JSONException {
        JSONObject values = new JSONObject()
                .put("time_local", timeLocal == null
                        ? JSONObject.NULL
                        : WIRE_TIME.format(timeLocal))
                .put("days_of_week", daysOfWeek == null
                        ? JSONObject.NULL
                        : new JSONArray(daysOfWeek))
                .put("timezone", timezone == null ? JSONObject.NULL : timezone.getId())
                .put("portion_grams", portionGrams == null ? JSONObject.NULL : portionGrams)
                .put("active", active);
        return new ScheduleRequest(
                ApiJson.requiredLocalTime(values, "time_local"),
                ApiJson.requiredDays(values, "days_of_week"),
                ApiJson.requiredZoneId(values, "timezone"),
                ApiJson.requiredPositiveGrams(values, "portion_grams"),
                ApiJson.requiredBoolean(values, "active")
        );
    }

    public JSONObject toJson() throws JSONException {
        return new JSONObject()
                .put("time_local", WIRE_TIME.format(timeLocal))
                .put("days_of_week", new JSONArray(daysOfWeek))
                .put("timezone", timezone.getId())
                .put("portion_grams", portionGrams)
                .put("active", active);
    }
}
