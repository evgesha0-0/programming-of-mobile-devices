package ru.smartcatfeeder;

import org.json.JSONException;

import java.math.BigDecimal;
import java.time.DateTimeException;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Преобразует значения формы расписания в проверенный запрос API. */
public final class ScheduleEditorInput {
    private static final List<String> DAYS = Arrays.asList(
            "mon", "tue", "wed", "thu", "fri", "sat", "sun"
    );

    private ScheduleEditorInput() {
    }

    public static ScheduleRequest toRequest(
            int hour,
            int minute,
            boolean[] selectedDays,
            String timezone,
            String portionGrams,
            boolean active
    ) {
        if (selectedDays == null || selectedDays.length != DAYS.size()) {
            throw new IllegalArgumentException("Некорректный набор дней недели");
        }

        List<String> days = new ArrayList<>();
        for (int index = 0; index < selectedDays.length; index++) {
            if (selectedDays[index]) {
                days.add(DAYS.get(index));
            }
        }
        if (days.isEmpty()) {
            throw new IllegalArgumentException("Выберите хотя бы один день недели");
        }

        LocalTime time;
        try {
            time = LocalTime.of(hour, minute);
        } catch (DateTimeException error) {
            throw new IllegalArgumentException("Проверьте время кормления", error);
        }

        ZoneId zone;
        try {
            zone = ZoneId.of(requireText(timezone));
        } catch (DateTimeException | IllegalArgumentException error) {
            throw new IllegalArgumentException("Проверьте часовой пояс IANA", error);
        }

        BigDecimal portion;
        try {
            portion = new BigDecimal(requireText(portionGrams).replace(',', '.'));
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Проверьте размер порции", error);
        }

        try {
            return ScheduleRequest.create(time, days, zone, portion, active);
        } catch (JSONException error) {
            throw new IllegalArgumentException("Проверьте параметры расписания", error);
        }
    }

    private static String requireText(String value) {
        String result = value == null ? "" : value.trim();
        if (result.isEmpty()) {
            throw new IllegalArgumentException();
        }
        return result;
    }
}
