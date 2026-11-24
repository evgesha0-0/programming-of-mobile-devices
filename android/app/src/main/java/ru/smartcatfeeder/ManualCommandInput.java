package ru.smartcatfeeder;

import org.json.JSONException;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/** Создаёт новую идемпотентную команду из значения формы ручного кормления. */
public final class ManualCommandInput {
    static final Duration COMMAND_LIFETIME = Duration.ofMinutes(5);

    private ManualCommandInput() {
    }

    public static ManualCommand create(String portionGrams, Instant now, UUID commandId) {
        Objects.requireNonNull(now, "now");
        Objects.requireNonNull(commandId, "commandId");

        BigDecimal portion;
        try {
            String value = portionGrams == null ? "" : portionGrams.trim();
            portion = new BigDecimal(value.replace(',', '.'));
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("Проверьте размер порции", error);
        }

        try {
            return ManualCommand.create(
                    commandId.toString(),
                    portion,
                    now.plus(COMMAND_LIFETIME)
            );
        } catch (JSONException error) {
            throw new IllegalArgumentException("Проверьте размер порции", error);
        }
    }
}
