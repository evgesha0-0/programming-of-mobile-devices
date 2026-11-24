package ru.smartcatfeeder;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;

/** Ограничивает частоту и длительность опроса результата ручной команды. */
public final class ManualFeedingPollPolicy {
    public static final Duration INITIAL_DELAY = Duration.ofSeconds(2);
    public static final Duration RETRY_DELAY = Duration.ofSeconds(3);
    public static final Duration EXPIRY_GRACE = Duration.ofMinutes(1);

    private ManualFeedingPollPolicy() {
    }

    public static boolean shouldContinue(
            Feeding feeding,
            Instant commandExpiresAt,
            Instant now
    ) {
        Objects.requireNonNull(feeding, "feeding");
        Objects.requireNonNull(commandExpiresAt, "commandExpiresAt");
        Objects.requireNonNull(now, "now");
        return !feeding.terminal()
                && now.isBefore(commandExpiresAt.plus(EXPIRY_GRACE));
    }
}
