package ru.smartcatfeeder;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class FeedingHistoryPage {
    public final List<Feeding> items;
    public final String nextCursor;

    private FeedingHistoryPage(List<Feeding> items, String nextCursor) {
        this.items = items;
        this.nextCursor = nextCursor;
    }

    public static FeedingHistoryPage parse(JSONObject body, String expectedDeviceId)
            throws JSONException {
        Object rawItems = body.get("items");
        if (!(rawItems instanceof JSONArray)) {
            throw new JSONException("items must be an array");
        }
        JSONArray array = (JSONArray) rawItems;
        List<Feeding> items = new ArrayList<>();
        Set<String> identifiers = new HashSet<>();
        for (int index = 0; index < array.length(); index++) {
            Object rawItem = array.get(index);
            if (!(rawItem instanceof JSONObject)) {
                throw new JSONException("feeding item must be an object");
            }
            Feeding feeding = Feeding.parse((JSONObject) rawItem, expectedDeviceId);
            if (!identifiers.add(feeding.feedingId)) {
                throw new JSONException("duplicate feeding_id in page");
            }
            items.add(feeding);
        }
        return new FeedingHistoryPage(
                Collections.unmodifiableList(items),
                ApiJson.nullableString(body, "next_cursor")
        );
    }
}
