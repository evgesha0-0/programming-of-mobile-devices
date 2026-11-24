package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

public final class ManualCommandInputTest {
    private static final UUID COMMAND_ID =
            UUID.fromString("1875723f-f6e1-4307-92c8-81577f1ea2fb");

    @Test
    public void createsIdempotentCommandWithLimitedLifetime() {
        Instant now = Instant.parse("2026-11-24T10:00:00Z");

        ManualCommand command = ManualCommandInput.create(" 40,50 ", now, COMMAND_ID);

        assertEquals(COMMAND_ID.toString(), command.commandId);
        assertEquals(0, new BigDecimal("40.50").compareTo(command.portionGrams));
        assertEquals(now.plus(ManualCommandInput.COMMAND_LIFETIME), command.expiresAt);
    }

    @Test
    public void rejectsInvalidPortionBeforeCreatingCommand() {
        Instant now = Instant.parse("2026-11-24T10:00:00Z");

        assertThrows(
                IllegalArgumentException.class,
                () -> ManualCommandInput.create("", now, COMMAND_ID)
        );
        assertThrows(
                IllegalArgumentException.class,
                () -> ManualCommandInput.create("0", now, COMMAND_ID)
        );
        assertThrows(
                IllegalArgumentException.class,
                () -> ManualCommandInput.create("10.001", now, COMMAND_ID)
        );
        assertThrows(
                IllegalArgumentException.class,
                () -> ManualCommandInput.create("abc", now, COMMAND_ID)
        );
    }

    @Test
    public void requiresClockAndIdentifier() {
        Instant now = Instant.parse("2026-11-24T10:00:00Z");

        assertThrows(
                NullPointerException.class,
                () -> ManualCommandInput.create("40", null, COMMAND_ID)
        );
        assertThrows(
                NullPointerException.class,
                () -> ManualCommandInput.create("40", now, null)
        );
    }
}
