package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.math.BigDecimal;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.Arrays;

public final class ScheduleEditorInputTest {
    @Test
    public void convertsFormValuesToValidatedRequest() {
        ScheduleRequest request = ScheduleEditorInput.toRequest(
                8,
                30,
                new boolean[]{true, false, true, false, true, false, false},
                " Asia/Yekaterinburg ",
                "45,50",
                true
        );

        assertEquals(LocalTime.of(8, 30), request.timeLocal);
        assertEquals(Arrays.asList("mon", "wed", "fri"), request.daysOfWeek);
        assertEquals(ZoneId.of("Asia/Yekaterinburg"), request.timezone);
        assertEquals(0, new BigDecimal("45.50").compareTo(request.portionGrams));
        assertTrue(request.active);
    }

    @Test
    public void keepsInactiveScheduleFlag() {
        ScheduleRequest request = ScheduleEditorInput.toRequest(
                23,
                5,
                new boolean[]{false, false, false, false, false, true, true},
                "Europe/Moscow",
                "12.5",
                false
        );

        assertEquals(Arrays.asList("sat", "sun"), request.daysOfWeek);
        assertFalse(request.active);
    }

    @Test
    public void rejectsIncompleteOrInvalidForm() {
        assertThrows(IllegalArgumentException.class, () -> ScheduleEditorInput.toRequest(
                8,
                30,
                new boolean[7],
                "Europe/Moscow",
                "40",
                true
        ));
        assertThrows(IllegalArgumentException.class, () -> ScheduleEditorInput.toRequest(
                8,
                30,
                new boolean[]{true, false, false, false, false, false, false},
                "UTC+5",
                "40",
                true
        ));
        assertThrows(IllegalArgumentException.class, () -> ScheduleEditorInput.toRequest(
                8,
                30,
                new boolean[]{true, false, false, false, false, false, false},
                "Europe/Moscow",
                "0",
                true
        ));
        assertThrows(IllegalArgumentException.class, () -> ScheduleEditorInput.toRequest(
                8,
                30,
                new boolean[]{true, false, false, false, false, false, false},
                "Europe/Moscow",
                "abc",
                true
        ));
    }
}
