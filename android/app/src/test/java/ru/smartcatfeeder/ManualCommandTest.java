package ru.smartcatfeeder;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

import java.math.BigDecimal;
import java.time.Instant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public final class ManualCommandTest {
    @Test
    public void createsStableJsonRequestWithoutLosingPrecision() throws Exception {
        ManualCommand command = command();

        JSONObject body = command.toJson();

        assertEquals(FeedingTest.COMMAND_ID, body.getString("command_id"));
        assertEquals(new BigDecimal("40.00"), body.get("portion_grams"));
        assertEquals("2026-10-17T08:20:00Z", body.getString("expires_at"));
        assertEquals(body.toString(), command.toJson().toString());
    }

    @Test
    public void rejectsInvalidCommandFields() {
        assertThrows(
                JSONException.class,
                () -> ManualCommand.create(
                        "not-a-uuid",
                        new BigDecimal("40"),
                        Instant.parse("2026-10-17T08:20:00Z")
                )
        );
        assertThrows(
                JSONException.class,
                () -> ManualCommand.create(
                        FeedingTest.COMMAND_ID,
                        new BigDecimal("0"),
                        Instant.parse("2026-10-17T08:20:00Z")
                )
        );
    }

    @Test
    public void acceptsOnlyResponseForExactOriginalCommand() throws Exception {
        ManualCommand command = command();
        JSONObject response = FeedingTest.completedManual()
                .put("expires_at", command.expiresAt.toString());

        ManualCommandResponse parsed = ManualCommandResponse.parse(
                response,
                FeedingTest.DEVICE_ID,
                command
        );
        assertEquals(FeedingTest.FEEDING_ID, parsed.feeding.feedingId);
        assertEquals(command.expiresAt, parsed.expiresAt);

        response.put("portion_grams", new BigDecimal("41.00"));
        assertThrows(
                JSONException.class,
                () -> ManualCommandResponse.parse(response, FeedingTest.DEVICE_ID, command)
        );
        response.put("portion_grams", new BigDecimal("40.00"));
        response.put("expires_at", "2026-10-17T08:21:00Z");
        assertThrows(
                JSONException.class,
                () -> ManualCommandResponse.parse(response, FeedingTest.DEVICE_ID, command)
        );
    }

    private static ManualCommand command() throws JSONException {
        return ManualCommand.create(
                FeedingTest.COMMAND_ID,
                new BigDecimal("40.00"),
                Instant.parse("2026-10-17T08:20:00Z")
        );
    }
}
