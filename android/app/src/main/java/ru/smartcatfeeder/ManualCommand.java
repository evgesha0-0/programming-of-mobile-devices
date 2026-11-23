package ru.smartcatfeeder;

import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.time.Instant;

public final class ManualCommand {
    public final String commandId;
    public final BigDecimal portionGrams;
    public final Instant expiresAt;

    private ManualCommand(String commandId, BigDecimal portionGrams, Instant expiresAt) {
        this.commandId = commandId;
        this.portionGrams = portionGrams;
        this.expiresAt = expiresAt;
    }

    public static ManualCommand create(
            String commandId,
            BigDecimal portionGrams,
            Instant expiresAt
    ) throws JSONException {
        JSONObject values = new JSONObject()
                .put("command_id", commandId)
                .put("portion_grams", portionGrams)
                .put("expires_at", expiresAt == null ? JSONObject.NULL : expiresAt.toString());
        return parse(values);
    }

    public static ManualCommand parse(JSONObject body) throws JSONException {
        return new ManualCommand(
                ApiJson.requiredUuid(body, "command_id"),
                ApiJson.requiredPositiveGrams(body, "portion_grams"),
                ApiJson.requiredInstant(body, "expires_at")
        );
    }

    public JSONObject toJson() throws JSONException {
        return new JSONObject()
                .put("command_id", commandId)
                .put("portion_grams", portionGrams)
                .put("expires_at", expiresAt.toString());
    }
}
