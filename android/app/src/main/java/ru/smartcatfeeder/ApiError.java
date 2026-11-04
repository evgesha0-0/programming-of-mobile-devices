package ru.smartcatfeeder;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class ApiError {
    public final String code;
    public final String message;
    public final List<Detail> details;
    public final String requestId;

    private ApiError(String code, String message, List<Detail> details, String requestId) {
        this.code = code;
        this.message = message;
        this.details = details;
        this.requestId = requestId;
    }

    public static ApiError parse(JSONObject body) throws JSONException {
        JSONObject error = ApiJson.requiredObject(body, "error");
        List<Detail> details = new ArrayList<>();
        if (error.has("details") && !error.isNull("details")) {
            Object rawDetails = error.get("details");
            if (!(rawDetails instanceof JSONArray)) {
                throw new JSONException("error.details must be an array");
            }
            JSONArray array = (JSONArray) rawDetails;
            for (int index = 0; index < array.length(); index++) {
                Object rawDetail = array.get(index);
                if (!(rawDetail instanceof JSONObject)) {
                    throw new JSONException("error detail must be an object");
                }
                JSONObject detail = (JSONObject) rawDetail;
                details.add(new Detail(
                        ApiJson.requiredString(detail, "field"),
                        ApiJson.requiredString(detail, "reason")
                ));
            }
        }
        return new ApiError(
                ApiJson.requiredString(error, "code"),
                ApiJson.requiredString(error, "message"),
                Collections.unmodifiableList(details),
                ApiJson.requiredString(error, "request_id")
        );
    }

    public static final class Detail {
        public final String field;
        public final String reason;

        private Detail(String field, String reason) {
            this.field = field;
            this.reason = reason;
        }
    }
}
