package ru.smartcatfeeder;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public final class ApiErrorTest {
    @Test
    public void parsesStructuredApiError() throws Exception {
        JSONObject body = new JSONObject().put("error", new JSONObject()
                .put("code", "VALIDATION_ERROR")
                .put("message", "Поле portion_grams должно быть положительным")
                .put("details", new JSONArray().put(new JSONObject()
                        .put("field", "portion_grams")
                        .put("reason", "must_be_positive")))
                .put("request_id", "req_01JAG4M6Y7R2"));

        ApiError error = ApiError.parse(body);

        assertEquals("VALIDATION_ERROR", error.code);
        assertEquals("req_01JAG4M6Y7R2", error.requestId);
        assertEquals(1, error.details.size());
        assertEquals("portion_grams", error.details.get(0).field);
        assertEquals("must_be_positive", error.details.get(0).reason);
    }

    @Test
    public void supportsErrorWithoutDetailsAndRejectsMalformedShape() throws Exception {
        JSONObject error = new JSONObject()
                .put("code", "INTERNAL_ERROR")
                .put("message", "Внутренняя ошибка")
                .put("request_id", "req_1");
        assertEquals(0, ApiError.parse(new JSONObject().put("error", error)).details.size());

        error.put("details", new JSONObject());
        assertThrows(
                JSONException.class,
                () -> ApiError.parse(new JSONObject().put("error", error))
        );
        assertThrows(JSONException.class, () -> ApiError.parse(new JSONObject()));
    }
}
