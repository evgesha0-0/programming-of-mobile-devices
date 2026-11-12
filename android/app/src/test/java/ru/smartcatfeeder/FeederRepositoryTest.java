package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.io.IOException;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Queue;

public final class FeederRepositoryTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";
    private static final String SCHEDULE_ID = "36ee8225-cd00-46ea-b6ef-db9e66c0946b";
    private static final String COMMAND_ID = "1875723f-f6e1-4307-92c8-81577f1ea2fb";
    private static final String FEEDING_ID = "ebc2fd74-7272-4c9e-a416-bdffde906913";

    @Test
    public void routesTypedOperationsToDocumentedResources() throws Exception {
        FakeTransport transport = new FakeTransport();
        FeederRepository repository = new FeederRepository(DEVICE_ID, transport);
        ScheduleRequest scheduleRequest = ScheduleRequest.create(
                LocalTime.of(8, 30),
                Arrays.asList("mon", "wed", "fri"),
                ZoneId.of("Asia/Yekaterinburg"),
                new BigDecimal("45.0"),
                true
        );
        ManualCommand command = ManualCommand.create(
                COMMAND_ID,
                new BigDecimal("40.0"),
                Instant.parse("2026-10-17T08:20:00Z")
        );

        transport.add(stateJson());
        assertEquals(DeviceState.Status.ONLINE, repository.getDeviceState().status);

        transport.add(scheduleListJson());
        assertEquals(1, repository.getSchedules().items.size());

        transport.add(scheduleJson(12));
        assertEquals(SCHEDULE_ID, repository.createSchedule(scheduleRequest).scheduleId);

        transport.add(scheduleJson(13));
        assertEquals(13L, repository.updateSchedule(SCHEDULE_ID, scheduleRequest)
                .scheduleRevision.longValue());

        transport.add(deletionJson());
        assertEquals(14L, repository.deleteSchedule(SCHEDULE_ID).scheduleRevision);

        transport.add(manualFeedingJson());
        assertEquals(FEEDING_ID, repository.createManualCommand(command).feeding.feedingId);

        transport.add(historyJson());
        assertEquals("next page", repository.getFeedingHistory(25, "next page").nextCursor);

        transport.add(completedFeedingJson());
        assertTrue(repository.getFeeding(FEEDING_ID).terminal());

        assertCall(transport.calls.get(0), FeederHttpClient.Method.GET, "/state", null);
        assertCall(transport.calls.get(1), FeederHttpClient.Method.GET, "/schedules", null);
        assertCall(transport.calls.get(2), FeederHttpClient.Method.POST, "/schedules", "08:30:00");
        assertCall(
                transport.calls.get(3),
                FeederHttpClient.Method.PUT,
                "/schedules/" + SCHEDULE_ID,
                "08:30:00"
        );
        assertCall(
                transport.calls.get(4),
                FeederHttpClient.Method.DELETE,
                "/schedules/" + SCHEDULE_ID,
                null
        );
        assertCall(
                transport.calls.get(5),
                FeederHttpClient.Method.POST,
                "/feeding-commands",
                COMMAND_ID
        );
        assertCall(
                transport.calls.get(6),
                FeederHttpClient.Method.GET,
                "/feedings?limit=25&cursor=next%20page",
                null
        );
        assertCall(
                transport.calls.get(7),
                FeederHttpClient.Method.GET,
                "/feedings/" + FEEDING_ID,
                null
        );
    }

    @Test
    public void defaultHistoryUsesContractLimitWithoutCursor() throws Exception {
        FakeTransport transport = new FakeTransport();
        transport.add(new JSONObject().put("items", new org.json.JSONArray())
                .put("next_cursor", JSONObject.NULL));

        FeedingHistoryPage page = new FeederRepository(DEVICE_ID, transport)
                .getFeedingHistory();

        assertTrue(page.items.isEmpty());
        assertNull(page.nextCursor);
        assertEquals("/feedings?limit=50", transport.calls.get(0).resource);
    }

    @Test
    public void rejectsInvalidIdentifiersAndPaginationBeforeTransport() {
        FakeTransport transport = new FakeTransport();
        FeederRepository repository = new FeederRepository(DEVICE_ID, transport);

        assertThrows(IllegalArgumentException.class, () -> repository.getFeeding("../state"));
        assertThrows(IllegalArgumentException.class, () -> repository.deleteSchedule("bad-id"));
        assertThrows(IllegalArgumentException.class, () -> repository.getFeedingHistory(0, null));
        assertThrows(IllegalArgumentException.class, () -> repository.getFeedingHistory(10, ""));
        assertTrue(transport.calls.isEmpty());
    }

    @Test
    public void rejectsResponseForAnotherResource() throws Exception {
        FakeTransport transport = new FakeTransport();
        String otherFeedingId = "1298e5e1-f5f4-44c8-8804-5ad0aafe8112";
        transport.add(completedFeedingJson().put("feeding_id", otherFeedingId));

        IOException error = assertThrows(
                IOException.class,
                () -> new FeederRepository(DEVICE_ID, transport).getFeeding(FEEDING_ID)
        );
        assertTrue(error.getCause() instanceof org.json.JSONException);
    }

    private static void assertCall(
            Call call,
            FeederHttpClient.Method method,
            String resource,
            String bodyFragment
    ) {
        assertEquals(method, call.method);
        assertEquals(resource, call.resource);
        if (bodyFragment == null) {
            assertNull(call.body);
        } else {
            assertTrue(call.body.contains(bodyFragment));
        }
    }

    private static JSONObject stateJson() throws Exception {
        return new JSONObject()
                .put("device_id", DEVICE_ID)
                .put("status", "online")
                .put("last_seen_at", "2026-10-17T08:15:30Z")
                .put("last_error", JSONObject.NULL)
                .put("schedule_revision", 12);
    }

    private static JSONObject scheduleListJson() throws Exception {
        return new JSONObject()
                .put("device_id", DEVICE_ID)
                .put("schedule_revision", 12)
                .put("items", new org.json.JSONArray().put(scheduleJson(null)));
    }

    private static JSONObject scheduleJson(Integer revision) throws Exception {
        JSONObject result = new JSONObject()
                .put("schedule_id", SCHEDULE_ID)
                .put("device_id", DEVICE_ID)
                .put("time_local", "08:30:00")
                .put("days_of_week", new org.json.JSONArray(Arrays.asList("mon", "wed", "fri")))
                .put("timezone", "Asia/Yekaterinburg")
                .put("portion_grams", 45.0)
                .put("active", true)
                .put("created_at", "2026-10-17T07:00:00Z")
                .put("updated_at", "2026-10-17T07:00:00Z");
        if (revision != null) {
            result.put("schedule_revision", revision);
        }
        return result;
    }

    private static JSONObject deletionJson() throws Exception {
        return new JSONObject()
                .put("schedule_id", SCHEDULE_ID)
                .put("deleted", true)
                .put("schedule_revision", 14)
                .put("deleted_at", "2026-10-17T07:45:00Z");
    }

    private static JSONObject manualFeedingJson() throws Exception {
        return new JSONObject()
                .put("feeding_id", FEEDING_ID)
                .put("device_id", DEVICE_ID)
                .put("schedule_id", JSONObject.NULL)
                .put("command_id", COMMAND_ID)
                .put("source", "manual")
                .put("portion_grams", 40.0)
                .put("status", "pending")
                .put("created_at", "2026-10-17T08:15:00Z")
                .put("expires_at", "2026-10-17T08:20:00Z")
                .put("started_at", JSONObject.NULL)
                .put("finished_at", JSONObject.NULL)
                .put("actual_grams", JSONObject.NULL)
                .put("error_code", JSONObject.NULL);
    }

    private static JSONObject completedFeedingJson() throws Exception {
        return manualFeedingJson()
                .put("status", "completed")
                .put("started_at", "2026-10-17T08:15:20Z")
                .put("finished_at", "2026-10-17T08:15:32Z")
                .put("actual_grams", 39.5);
    }

    private static JSONObject historyJson() throws Exception {
        return new JSONObject()
                .put("items", new org.json.JSONArray().put(completedFeedingJson()))
                .put("next_cursor", "next page");
    }

    private static final class FakeTransport implements FeederRepository.Transport {
        private final Queue<JSONObject> responses = new ArrayDeque<>();
        private final List<Call> calls = new ArrayList<>();

        void add(JSONObject response) {
            responses.add(response);
        }

        @Override
        public JSONObject execute(
                FeederHttpClient.Method method,
                String resource,
                JSONObject requestBody
        ) throws IOException {
            calls.add(new Call(method, resource, requestBody == null ? null : requestBody.toString()));
            JSONObject response = responses.poll();
            if (response == null) {
                throw new IOException("No fake response");
            }
            return response;
        }
    }

    private static final class Call {
        final FeederHttpClient.Method method;
        final String resource;
        final String body;

        Call(FeederHttpClient.Method method, String resource, String body) {
            this.method = method;
            this.resource = resource;
            this.body = body;
        }
    }
}
