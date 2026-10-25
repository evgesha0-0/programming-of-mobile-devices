package ru.smartcatfeeder;

import org.json.JSONException;
import org.json.JSONObject;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

public final class ManualCommand {
    private ManualCommand() {}

    public static BigDecimal portion(String input) {
        try {
            BigDecimal amount = new BigDecimal(input.trim().replace(',', '.'));
            if (amount.signum() <= 0 || amount.stripTrailingZeros().scale() > 2
                    || amount.compareTo(new BigDecimal("999999.99")) > 0) throw new NumberFormatException();
            return amount;
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("Введите положительную массу в граммах, не более двух знаков после запятой");
        }
    }

    public static JSONObject create(String portion, Instant now) throws JSONException {
        return new JSONObject().put("command_id", UUID.randomUUID().toString())
                .put("portion_grams", portion(portion))
                .put("expires_at", now.plusSeconds(300).toString());
    }

    public static boolean terminal(String status) {
        return "completed".equals(status) || "failed".equals(status) || "expired".equals(status);
    }
}
