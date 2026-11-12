package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.List;

public final class FeedingHistoryStateTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";
    private static final String COMMAND_ID = "1875723f-f6e1-4307-92c8-81577f1ea2fb";
    private static final String FIRST_ID = "ebc2fd74-7272-4c9e-a416-bdffde906913";
    private static final String SECOND_ID = "1298e5e1-f5f4-44c8-8804-5ad0aafe8112";
    private static final String THIRD_ID = "dad32b9d-c430-4dfc-b93f-ac5ef7789927";

    @Test
    public void combinesPagesAndRemovesCrossPageDuplicates() throws Exception {
        FeedingHistoryState state = new FeedingHistoryState();
        state.applyFirstPage(page("cursor-2", FIRST_ID, SECOND_ID));

        assertTrue(state.hasMore());
        assertEquals("cursor-2", state.nextCursor());

        state.appendPage(page(null, SECOND_ID, THIRD_ID));

        List<Feeding> items = state.items();
        assertEquals(3, items.size());
        assertEquals(FIRST_ID, items.get(0).feedingId);
        assertEquals(SECOND_ID, items.get(1).feedingId);
        assertEquals(THIRD_ID, items.get(2).feedingId);
        assertFalse(state.hasMore());
        assertThrows(UnsupportedOperationException.class, () -> items.clear());
    }

    @Test
    public void firstPageReplacesPreviousHistory() throws Exception {
        FeedingHistoryState state = new FeedingHistoryState();
        state.applyFirstPage(page("old", FIRST_ID));

        state.applyFirstPage(page(null, THIRD_ID));

        assertEquals(1, state.items().size());
        assertEquals(THIRD_ID, state.items().get(0).feedingId);
        assertFalse(state.hasMore());
    }

    @Test
    public void repeatedCursorStopsPaginationLoop() throws Exception {
        FeedingHistoryState state = new FeedingHistoryState();
        state.applyFirstPage(page("same-cursor", FIRST_ID));

        state.appendPage(page("same-cursor", SECOND_ID));

        assertEquals(2, state.items().size());
        assertFalse(state.hasMore());
    }

    private static FeedingHistoryPage page(String cursor, String... feedingIds)
            throws Exception {
        JSONArray items = new JSONArray();
        for (String feedingId : feedingIds) {
            items.put(feeding(feedingId));
        }
        return FeedingHistoryPage.parse(
                new JSONObject()
                        .put("items", items)
                        .put("next_cursor", cursor == null ? JSONObject.NULL : cursor),
                DEVICE_ID
        );
    }

    private static JSONObject feeding(String feedingId) throws Exception {
        return new JSONObject()
                .put("feeding_id", feedingId)
                .put("device_id", DEVICE_ID)
                .put("schedule_id", JSONObject.NULL)
                .put("command_id", COMMAND_ID)
                .put("source", "manual")
                .put("portion_grams", 40.0)
                .put("actual_grams", 39.5)
                .put("status", "completed")
                .put("created_at", "2026-10-17T08:15:00Z")
                .put("started_at", "2026-10-17T08:15:20Z")
                .put("finished_at", "2026-10-17T08:15:32Z")
                .put("error_code", JSONObject.NULL)
                .put("error_message", JSONObject.NULL);
    }
}
