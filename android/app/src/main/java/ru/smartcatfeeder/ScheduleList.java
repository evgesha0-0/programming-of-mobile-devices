package ru.smartcatfeeder;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class ScheduleList {
    public final String deviceId;
    public final long scheduleRevision;
    public final List<Schedule> items;

    private ScheduleList(String deviceId, long scheduleRevision, List<Schedule> items) {
        this.deviceId = deviceId;
        this.scheduleRevision = scheduleRevision;
        this.items = items;
    }

    public static ScheduleList parse(JSONObject body, String expectedDeviceId) throws JSONException {
        String deviceId = ApiJson.requiredUuid(body, "device_id");
        ApiJson.requireExpectedId(deviceId, expectedDeviceId, "device_id");
        long revision = ApiJson.requiredNonNegativeLong(body, "schedule_revision");
        Object rawItems = body.get("items");
        if (!(rawItems instanceof JSONArray)) {
            throw new JSONException("items must be an array");
        }

        JSONArray array = (JSONArray) rawItems;
        List<Schedule> items = new ArrayList<>();
        Set<String> identifiers = new HashSet<>();
        for (int index = 0; index < array.length(); index++) {
            Object rawItem = array.get(index);
            if (!(rawItem instanceof JSONObject)) {
                throw new JSONException("schedule item must be an object");
            }
            Schedule schedule = Schedule.parse((JSONObject) rawItem, deviceId);
            if (!identifiers.add(schedule.scheduleId)) {
                throw new JSONException("duplicate schedule_id");
            }
            items.add(schedule);
        }
        return new ScheduleList(deviceId, revision, Collections.unmodifiableList(items));
    }
}
