package ru.smartcatfeeder;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Objects;

/** Типизированная точка доступа Android-клиента к REST API кормушки. */
public final class FeederRepository {
    private static final int DEFAULT_HISTORY_LIMIT = 50;

    private final String deviceId;
    private final Transport transport;

    public FeederRepository(ConnectionSettings settings) {
        Objects.requireNonNull(settings, "settings");
        FeederHttpClient client = new FeederHttpClient(settings);
        this.deviceId = settings.deviceId;
        this.transport = client::execute;
    }

    FeederRepository(String deviceId, Transport transport) {
        this.deviceId = canonicalUuid(deviceId, "device_id");
        this.transport = Objects.requireNonNull(transport, "transport");
    }

    public DeviceState getDeviceState() throws IOException {
        JSONObject response = execute(FeederHttpClient.Method.GET, "/state", null);
        return parseResponse(response, body -> DeviceState.parse(body, deviceId));
    }

    public ScheduleList getSchedules() throws IOException {
        JSONObject response = execute(FeederHttpClient.Method.GET, "/schedules", null);
        return parseResponse(response, body -> ScheduleList.parse(body, deviceId));
    }

    public Schedule createSchedule(ScheduleRequest request) throws IOException {
        Objects.requireNonNull(request, "request");
        JSONObject response = execute(
                FeederHttpClient.Method.POST,
                "/schedules",
                scheduleBody(request)
        );
        return parseResponse(response, body -> Schedule.parse(body, deviceId));
    }

    public Schedule updateSchedule(String scheduleId, ScheduleRequest request) throws IOException {
        String safeScheduleId = canonicalUuid(scheduleId, "schedule_id");
        Objects.requireNonNull(request, "request");
        JSONObject response = execute(
                FeederHttpClient.Method.PUT,
                "/schedules/" + safeScheduleId,
                scheduleBody(request)
        );
        return parseResponse(response, body -> {
            Schedule schedule = Schedule.parse(body, deviceId);
            ApiJson.requireExpectedId(schedule.scheduleId, safeScheduleId, "schedule_id");
            return schedule;
        });
    }

    public ScheduleDeletion deleteSchedule(String scheduleId) throws IOException {
        String safeScheduleId = canonicalUuid(scheduleId, "schedule_id");
        JSONObject response = execute(
                FeederHttpClient.Method.DELETE,
                "/schedules/" + safeScheduleId,
                null
        );
        return parseResponse(response, body -> ScheduleDeletion.parse(body, safeScheduleId));
    }

    public ManualCommandResponse createManualCommand(ManualCommand command) throws IOException {
        Objects.requireNonNull(command, "command");
        JSONObject response = execute(
                FeederHttpClient.Method.POST,
                "/feeding-commands",
                manualCommandBody(command)
        );
        return parseResponse(
                response,
                body -> ManualCommandResponse.parse(body, deviceId, command)
        );
    }

    public FeedingHistoryPage getFeedingHistory() throws IOException {
        return getFeedingHistory(DEFAULT_HISTORY_LIMIT, null);
    }

    public FeedingHistoryPage getFeedingHistory(int limit, String cursor) throws IOException {
        if (limit <= 0) {
            throw new IllegalArgumentException("Лимит истории должен быть положительным");
        }
        String resource = "/feedings?limit=" + limit;
        if (cursor != null) {
            if (cursor.isEmpty()) {
                throw new IllegalArgumentException("Курсор истории не должен быть пустым");
            }
            resource += "&cursor=" + encodeQueryValue(cursor);
        }
        JSONObject response = execute(FeederHttpClient.Method.GET, resource, null);
        return parseResponse(response, body -> FeedingHistoryPage.parse(body, deviceId));
    }

    public Feeding getFeeding(String feedingId) throws IOException {
        String safeFeedingId = canonicalUuid(feedingId, "feeding_id");
        JSONObject response = execute(
                FeederHttpClient.Method.GET,
                "/feedings/" + safeFeedingId,
                null
        );
        return parseResponse(response, body -> {
            Feeding feeding = Feeding.parse(body, deviceId);
            ApiJson.requireExpectedId(feeding.feedingId, safeFeedingId, "feeding_id");
            return feeding;
        });
    }

    private JSONObject execute(
            FeederHttpClient.Method method,
            String resource,
            JSONObject requestBody
    ) throws IOException {
        return transport.execute(method, resource, requestBody);
    }

    private static JSONObject scheduleBody(ScheduleRequest request) throws IOException {
        try {
            return request.toJson();
        } catch (JSONException error) {
            throw new IOException("Не удалось сформировать запрос расписания", error);
        }
    }

    private static JSONObject manualCommandBody(ManualCommand command) throws IOException {
        try {
            return command.toJson();
        } catch (JSONException error) {
            throw new IOException("Не удалось сформировать ручную команду", error);
        }
    }

    private static <T> T parseResponse(JSONObject body, ResponseParser<T> parser)
            throws IOException {
        try {
            return parser.parse(body);
        } catch (JSONException error) {
            throw new IOException("Сервер вернул данные неверного формата", error);
        }
    }

    private static String canonicalUuid(String value, String key) {
        try {
            return ApiJson.requiredUuid(new JSONObject().put(key, value), key);
        } catch (JSONException error) {
            throw new IllegalArgumentException("Некорректный " + key, error);
        }
    }

    private static String encodeQueryValue(String value) {
        try {
            return URLEncoder.encode(value, StandardCharsets.UTF_8.name())
                    .replace("+", "%20");
        } catch (UnsupportedEncodingException impossible) {
            throw new IllegalStateException("UTF-8 недоступен", impossible);
        }
    }

    interface Transport {
        JSONObject execute(
                FeederHttpClient.Method method,
                String resource,
                JSONObject requestBody
        ) throws IOException;
    }

    private interface ResponseParser<T> {
        T parse(JSONObject body) throws JSONException;
    }
}
