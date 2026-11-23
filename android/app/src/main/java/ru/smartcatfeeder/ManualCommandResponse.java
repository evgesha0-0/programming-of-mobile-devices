package ru.smartcatfeeder;

import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;

public final class ManualCommandResponse {
    public final Feeding feeding;
    public final Instant expiresAt;

    private ManualCommandResponse(Feeding feeding, Instant expiresAt) {
        this.feeding = feeding;
        this.expiresAt = expiresAt;
    }

    public static ManualCommandResponse parse(
            JSONObject body,
            String expectedDeviceId,
            ManualCommand expectedCommand
    ) throws JSONException {
        Feeding feeding = Feeding.parse(body, expectedDeviceId);
        if (feeding.source != Feeding.Source.MANUAL
                || !expectedCommand.commandId.equals(feeding.commandId)
                || expectedCommand.portionGrams.compareTo(feeding.portionGrams) != 0) {
            throw new JSONException("Response belongs to another manual command");
        }
        Instant expiresAt = ApiJson.requiredInstant(body, "expires_at");
        if (!expectedCommand.expiresAt.equals(expiresAt)) {
            throw new JSONException("Response changed command expiration");
        }
        return new ManualCommandResponse(feeding, expiresAt);
    }
}
