package ru.smartcatfeeder;

import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Objects;

/** Подготовленные для строки списка значения расписания. */
public final class ScheduleViewData {
    private static final DateTimeFormatter TIME_FORMAT =
            DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT);

    public final String scheduleId;
    public final String time;
    public final List<Integer> dayTextResources;
    public final String timezone;
    public final String portionGrams;
    public final boolean active;

    private ScheduleViewData(
            String scheduleId,
            String time,
            List<Integer> dayTextResources,
            String timezone,
            String portionGrams,
            boolean active
    ) {
        this.scheduleId = scheduleId;
        this.time = time;
        this.dayTextResources = dayTextResources;
        this.timezone = timezone;
        this.portionGrams = portionGrams;
        this.active = active;
    }

    public static ScheduleViewData from(Schedule schedule) {
        Objects.requireNonNull(schedule, "schedule");
        List<Integer> days = new ArrayList<>();
        for (String day : schedule.daysOfWeek) {
            days.add(dayTextResource(day));
        }
        return new ScheduleViewData(
                schedule.scheduleId,
                TIME_FORMAT.format(schedule.timeLocal),
                Collections.unmodifiableList(days),
                schedule.timezone.getId(),
                schedule.portionGrams.stripTrailingZeros().toPlainString(),
                schedule.active
        );
    }

    private static int dayTextResource(String day) {
        return switch (day) {
            case "mon" -> R.string.day_mon_short;
            case "tue" -> R.string.day_tue_short;
            case "wed" -> R.string.day_wed_short;
            case "thu" -> R.string.day_thu_short;
            case "fri" -> R.string.day_fri_short;
            case "sat" -> R.string.day_sat_short;
            case "sun" -> R.string.day_sun_short;
            default -> throw new IllegalArgumentException("Неизвестный день недели");
        };
    }
}
