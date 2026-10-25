package ru.smartcatfeeder;

import org.json.JSONObject;
import org.junit.Test;
import java.math.BigDecimal;
import java.time.Instant;
import static org.junit.Assert.*;

public class ManualCommandTest {
    @Test public void parsesGramsWithoutLosingDecimalPrecision() {
        assertEquals(new BigDecimal("39.50"), ManualCommand.portion("39,50"));
        for (String input : new String[]{"", "0", "-1", "NaN", "0.001", "1000000", "abc"}) {
            assertThrows(input, IllegalArgumentException.class, () -> ManualCommand.portion(input));
        }
    }

    @Test public void commandHasStableBodyForRetryAndNewIdForNewIntent() throws Exception {
        Instant now = Instant.parse("2026-10-25T12:00:00Z");
        JSONObject command = ManualCommand.create("40", now);
        JSONObject restored = new JSONObject(command.toString());
        assertEquals(command.getString("command_id"), restored.getString("command_id"));
        assertEquals("2026-10-25T12:05:00Z", restored.getString("expires_at"));
        assertEquals(40, restored.getInt("portion_grams"));
        assertNotEquals(command.getString("command_id"), ManualCommand.create("40", now).getString("command_id"));
    }

    @Test public void acceptedCommandDoesNotMeanCompletedFeeding() {
        assertFalse(ManualCommand.terminal("pending"));
        assertFalse(ManualCommand.terminal("running"));
        assertTrue(ManualCommand.terminal("completed"));
        assertTrue(ManualCommand.terminal("failed"));
        assertTrue(ManualCommand.terminal("expired"));
    }
}
