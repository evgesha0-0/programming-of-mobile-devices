package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertThrows;

import org.json.JSONObject;
import org.junit.Test;

import java.math.BigDecimal;
import java.time.Instant;

public final class ManualFeedingSessionTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";
    private static final String COMMAND_ID = "1875723f-f6e1-4307-92c8-81577f1ea2fb";
    private static final String FEEDING_ID = "ebc2fd74-7272-4c9e-a416-bdffde906913";
    private static final Instant EXPIRES_AT = Instant.parse("2026-11-24T10:05:00Z");

    @Test
    public void uncertainAttemptRetriesExactSameCommandBeforeExpiry() throws Exception {
        ManualCommand command = command(COMMAND_ID);
        ManualFeedingSession session = new ManualFeedingSession();
        session.begin(command);

        session.markUncertain(command);

        assertEquals(ManualFeedingSession.State.RETRY_AVAILABLE, session.state());
        assertSame(
                command,
                session.retryCommand(Instant.parse("2026-11-24T10:04:59Z"))
        );
    }

    @Test
    public void expiredUncertainAttemptCannotBeRetried() throws Exception {
        ManualCommand command = command(COMMAND_ID);
        ManualFeedingSession session = new ManualFeedingSession();
        session.begin(command);
        session.markUncertain(command);

        assertNull(session.retryCommand(EXPIRES_AT));
        assertEquals(ManualFeedingSession.State.IDLE, session.state());
    }

    @Test
    public void acceptedResponseIsKeptForResultPolling() throws Exception {
        ManualCommand command = command(COMMAND_ID);
        ManualCommandResponse response = response(command);
        ManualFeedingSession session = new ManualFeedingSession();
        session.begin(command);

        session.markAccepted(command, response);

        assertEquals(ManualFeedingSession.State.ACCEPTED, session.state());
        assertSame(response, session.acceptedResponse());
        assertNull(session.retryCommand(Instant.parse("2026-11-24T10:01:00Z")));
    }

    @Test
    public void staleCommandCannotChangeCurrentAttempt() throws Exception {
        ManualCommand current = command(COMMAND_ID);
        ManualCommand stale = command("693df286-f089-463e-848d-5a19f7027449");
        ManualFeedingSession session = new ManualFeedingSession();
        session.begin(current);

        assertThrows(IllegalStateException.class, () -> session.markUncertain(stale));
        assertThrows(IllegalStateException.class, () -> session.markRejected(stale));
    }

    private static ManualCommand command(String commandId) throws Exception {
        return ManualCommand.create(commandId, new BigDecimal("40.0"), EXPIRES_AT);
    }

    private static ManualCommandResponse response(ManualCommand command) throws Exception {
        return ManualCommandResponse.parse(
                new JSONObject()
                        .put("command_id", command.commandId)
                        .put("feeding_id", FEEDING_ID)
                        .put("device_id", DEVICE_ID)
                        .put("schedule_id", JSONObject.NULL)
                        .put("source", "manual")
                        .put("portion_grams", 40.0)
                        .put("actual_grams", JSONObject.NULL)
                        .put("status", "pending")
                        .put("created_at", "2026-11-24T10:00:00Z")
                        .put("expires_at", EXPIRES_AT.toString())
                        .put("started_at", JSONObject.NULL)
                        .put("finished_at", JSONObject.NULL)
                        .put("error_code", JSONObject.NULL)
                        .put("error_message", JSONObject.NULL),
                DEVICE_ID,
                command
        );
    }
}
