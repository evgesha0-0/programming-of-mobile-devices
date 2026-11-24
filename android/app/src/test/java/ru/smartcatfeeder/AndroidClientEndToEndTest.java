package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.Arrays;

public final class AndroidClientEndToEndTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";
    private static final String SCHEDULE_ID = "36ee8225-cd00-46ea-b6ef-db9e66c0946b";
    private static final String COMMAND_ID = "1875723f-f6e1-4307-92c8-81577f1ea2fb";
    private static final String FEEDING_ID = "ebc2fd74-7272-4c9e-a416-bdffde906913";
    private static final String TOKEN =
            "usr_0123456789012345678901234567890123456789012";
    private static final String DEVICE_PATH = "/api/v1/devices/" + DEVICE_ID;

    @Test
    public void readsStateSchedulesAndPaginatedHistoryThroughHttpStack() throws Exception {
        try (FakeFeederApiServer server = new FakeFeederApiServer(TOKEN)) {
            server.enqueue("GET", DEVICE_PATH + "/state", null, 200, stateJson().toString());
            server.enqueue(
                    "GET",
                    DEVICE_PATH + "/schedules",
                    null,
                    200,
                    scheduleListJson().toString()
            );
            server.enqueue(
                    "GET",
                    DEVICE_PATH + "/feedings?limit=50",
                    null,
                    200,
                    historyPageJson("next page").toString()
            );
            server.enqueue(
                    "GET",
                    DEVICE_PATH + "/feedings?limit=50&cursor=next%20page",
                    null,
                    200,
                    new JSONObject()
                            .put("items", new JSONArray())
                            .put("next_cursor", JSONObject.NULL)
                            .toString()
            );
            server.start();
            FeederRepository repository = repository(server);

            DeviceState state = repository.getDeviceState();
            ScheduleList schedules = repository.getSchedules();
            FeedingHistoryState history = new FeedingHistoryState();
            history.applyFirstPage(repository.getFeedingHistory());
            history.appendPage(repository.getFeedingHistory(50, history.nextCursor()));

            assertEquals(DeviceState.Status.ONLINE, state.status);
            assertEquals(12L, state.scheduleRevision);
            assertEquals(1, schedules.items.size());
            assertEquals(SCHEDULE_ID, schedules.items.get(0).scheduleId);
            assertEquals(1, history.items().size());
            assertFalse(history.hasMore());
            server.await();
        }
    }

    @Test
    public void createsUpdatesAndDeletesScheduleThroughHttpStack() throws Exception {
        ScheduleRequest createRequest = ScheduleRequest.create(
                LocalTime.of(8, 30),
                Arrays.asList("mon", "wed", "fri"),
                ZoneId.of("Europe/Moscow"),
                new BigDecimal("45"),
                true
        );
        ScheduleRequest updateRequest = ScheduleRequest.create(
                LocalTime.of(9, 0),
                Arrays.asList("mon", "tue", "wed", "thu", "fri"),
                ZoneId.of("Europe/Moscow"),
                new BigDecimal("50"),
                true
        );
        try (FakeFeederApiServer server = new FakeFeederApiServer(TOKEN)) {
            server.enqueue(
                    "POST",
                    DEVICE_PATH + "/schedules",
                    createRequest.toJson().toString(),
                    201,
                    scheduleJson("08:30:00", 45, 12).toString()
            );
            server.enqueue(
                    "PUT",
                    DEVICE_PATH + "/schedules/" + SCHEDULE_ID,
                    updateRequest.toJson().toString(),
                    200,
                    scheduleJson("09:00:00", 50, 13).toString()
            );
            server.enqueue(
                    "DELETE",
                    DEVICE_PATH + "/schedules/" + SCHEDULE_ID,
                    null,
                    200,
                    new JSONObject()
                            .put("schedule_id", SCHEDULE_ID)
                            .put("deleted", true)
                            .put("schedule_revision", 14)
                            .put("deleted_at", "2026-11-24T10:00:00Z")
                            .toString()
            );
            server.start();
            FeederRepository repository = repository(server);

            Schedule created = repository.createSchedule(createRequest);
            Schedule updated = repository.updateSchedule(SCHEDULE_ID, updateRequest);
            ScheduleDeletion deleted = repository.deleteSchedule(SCHEDULE_ID);

            assertEquals(12L, created.scheduleRevision.longValue());
            assertEquals(LocalTime.of(9, 0), updated.timeLocal);
            assertEquals(14L, deleted.scheduleRevision);
            server.await();
        }
    }

    @Test
    public void sendsIdempotentCommandAndTracksTerminalResultThroughHttpStack()
            throws Exception {
        ManualCommand command = ManualCommand.create(
                COMMAND_ID,
                new BigDecimal("40"),
                Instant.parse("2026-11-24T10:05:00Z")
        );
        try (FakeFeederApiServer server = new FakeFeederApiServer(TOKEN)) {
            server.enqueue(
                    "POST",
                    DEVICE_PATH + "/feeding-commands",
                    command.toJson().toString(),
                    202,
                    pendingFeedingJson().put("expires_at", command.expiresAt.toString()).toString()
            );
            server.enqueue(
                    "GET",
                    DEVICE_PATH + "/feedings/" + FEEDING_ID,
                    null,
                    200,
                    completedFeedingJson().toString()
            );
            server.start();
            FeederRepository repository = repository(server);
            ManualFeedingSession session = new ManualFeedingSession();

            session.begin(command);
            ManualCommandResponse accepted = repository.createManualCommand(command);
            session.markAccepted(command, accepted);
            Feeding completed = repository.getFeeding(accepted.feeding.feedingId);
            session.updateFeeding(completed);
            FeedingNotificationData notification = FeedingNotificationData.from(completed);

            assertEquals(ManualFeedingSession.State.FINISHED, session.state());
            assertEquals(Feeding.Status.COMPLETED, session.currentFeeding().status);
            assertEquals("39.5", notification.bodyArgument);
            server.await();
        }
    }

    @Test
    public void unauthorizedResponseTriggersReauthenticationPolicy() throws Exception {
        try (FakeFeederApiServer server = new FakeFeederApiServer(TOKEN)) {
            server.enqueue(
                    "GET",
                    DEVICE_PATH + "/state",
                    null,
                    401,
                    new JSONObject().put("error", new JSONObject()
                            .put("code", "UNAUTHORIZED"))
                            .toString()
            );
            server.start();

            FeederHttpClient.ApiException error = assertThrows(
                    FeederHttpClient.ApiException.class,
                    () -> repository(server).getDeviceState()
            );

            assertEquals(401, error.status);
            assertEquals(
                    RepositoryFailurePolicy.Action.REAUTHENTICATE,
                    RepositoryFailurePolicy.actionFor(error)
            );
            server.await();
        }
    }

    private static FeederRepository repository(FakeFeederApiServer server) {
        ConnectionSettings settings = new ConnectionSettings(
                server.address(),
                DEVICE_ID,
                TOKEN,
                true
        );
        assertNotNull(settings.accessToken);
        return new FeederRepository(settings);
    }

    private static JSONObject stateJson() throws Exception {
        return new JSONObject()
                .put("device_id", DEVICE_ID)
                .put("status", "online")
                .put("last_seen_at", "2026-11-24T09:59:30Z")
                .put("last_error", JSONObject.NULL)
                .put("schedule_revision", 12);
    }

    private static JSONObject scheduleListJson() throws Exception {
        return new JSONObject()
                .put("device_id", DEVICE_ID)
                .put("schedule_revision", 12)
                .put("items", new JSONArray().put(scheduleJson("08:30:00", 45, null)));
    }

    private static JSONObject scheduleJson(String time, int portion, Integer revision)
            throws Exception {
        JSONObject result = new JSONObject()
                .put("schedule_id", SCHEDULE_ID)
                .put("device_id", DEVICE_ID)
                .put("time_local", time)
                .put("days_of_week", new JSONArray(Arrays.asList("mon", "wed", "fri")))
                .put("timezone", "Europe/Moscow")
                .put("portion_grams", portion)
                .put("active", true)
                .put("created_at", "2026-11-24T09:00:00Z")
                .put("updated_at", "2026-11-24T09:30:00Z");
        if (revision != null) {
            result.put("schedule_revision", revision);
        }
        return result;
    }

    private static JSONObject historyPageJson(String cursor) throws Exception {
        return new JSONObject()
                .put("items", new JSONArray().put(completedFeedingJson()))
                .put("next_cursor", cursor);
    }

    private static JSONObject pendingFeedingJson() throws Exception {
        return new JSONObject()
                .put("feeding_id", FEEDING_ID)
                .put("device_id", DEVICE_ID)
                .put("schedule_id", JSONObject.NULL)
                .put("command_id", COMMAND_ID)
                .put("source", "manual")
                .put("portion_grams", 40)
                .put("actual_grams", JSONObject.NULL)
                .put("status", "pending")
                .put("created_at", "2026-11-24T10:00:00Z")
                .put("started_at", JSONObject.NULL)
                .put("finished_at", JSONObject.NULL)
                .put("error_code", JSONObject.NULL)
                .put("error_message", JSONObject.NULL);
    }

    private static JSONObject completedFeedingJson() throws Exception {
        return pendingFeedingJson()
                .put("actual_grams", 39.5)
                .put("status", "completed")
                .put("started_at", "2026-11-24T10:00:10Z")
                .put("finished_at", "2026-11-24T10:00:20Z");
    }
}
