package ru.smartcatfeeder;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import java.math.BigDecimal;
import static org.junit.Assert.*;

public class FeedingResultTest {
    static final String FEEDING = "ebc2fd74-7272-4c9e-a416-bdffde906913";
    static final String COMMAND = "1875723f-f6e1-4307-92c8-81577f1ea2fb";

    static JSONObject body(String status) throws Exception {
        return new JSONObject().put("feeding_id", FEEDING).put("command_id", COMMAND)
                .put("source", "manual").put("status", status)
                .put("actual_grams", JSONObject.NULL).put("finished_at", JSONObject.NULL);
    }
    static FeedingResult parse(JSONObject body) throws JSONException { return FeedingResult.parse(FEEDING, COMMAND, body); }

    @Test public void completedRequiresMassAndValidFinishTime() throws Exception {
        JSONObject body = body("completed");
        assertThrows(JSONException.class, () -> parse(body));
        body.put("actual_grams", 39.5);
        assertThrows(JSONException.class, () -> parse(body));
        body.put("finished_at", "2026-10-25T12:00:00Z");
        FeedingResult result = parse(body);
        assertTrue(result.terminal());
        assertEquals(new BigDecimal("39.5"), result.actualGrams);
        body.put("actual_grams", "39.5");
        assertThrows(JSONException.class, () -> parse(body));
        body.put("actual_grams", -1);
        assertThrows(JSONException.class, () -> parse(body));
    }

    @Test public void unrelatedAndUnknownResultsAreRejected() throws Exception {
        JSONObject body = body("pending");
        body.put("feeding_id", "another-feeding");
        assertThrows(JSONException.class, () -> parse(body));
        body.put("feeding_id", FEEDING).put("command_id", "another-command");
        assertThrows(JSONException.class, () -> parse(body));
        body.put("command_id", COMMAND).put("source", "scheduled");
        assertThrows(JSONException.class, () -> parse(body));
        body.put("source", "manual").put("status", "success");
        assertThrows(JSONException.class, () -> parse(body));
    }

    @Test public void failuresAndExpiryDoNotRequireInventedWeight() throws Exception {
        JSONObject failed = body("failed").put("finished_at", "2026-10-25T12:00:00Z").put("error_code", "MOTOR_ERROR");
        assertTrue(parse(failed).terminal());
        assertNull(parse(failed).actualGrams);
        assertEquals("MOTOR_ERROR", parse(failed).errorCode);
        assertTrue(parse(body("expired")).terminal());
        assertFalse(parse(body("pending")).terminal());
        assertFalse(parse(body("running")).terminal());
    }
}
