package ru.smartcatfeeder;

import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.Objects;

/** Подготовленные для строки истории значения кормления. */
public final class FeedingViewData {
    private static final DateTimeFormatter TIME_FORMAT =
            DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm:ss", Locale.ROOT);

    public final String feedingId;
    public final int sourceTextResource;
    public final int statusTextResource;
    public final int statusColorResource;
    public final String createdAt;
    public final String portionGrams;
    public final String actualGrams;
    public final String errorDetails;

    private FeedingViewData(
            String feedingId,
            int sourceTextResource,
            int statusTextResource,
            int statusColorResource,
            String createdAt,
            String portionGrams,
            String actualGrams,
            String errorDetails
    ) {
        this.feedingId = feedingId;
        this.sourceTextResource = sourceTextResource;
        this.statusTextResource = statusTextResource;
        this.statusColorResource = statusColorResource;
        this.createdAt = createdAt;
        this.portionGrams = portionGrams;
        this.actualGrams = actualGrams;
        this.errorDetails = errorDetails;
    }

    public static FeedingViewData from(Feeding feeding, ZoneId displayZone) {
        Objects.requireNonNull(feeding, "feeding");
        Objects.requireNonNull(displayZone, "displayZone");
        return new FeedingViewData(
                feeding.feedingId,
                feeding.source == Feeding.Source.MANUAL
                        ? R.string.feeding_source_manual
                        : R.string.feeding_source_scheduled,
                statusText(feeding.status),
                statusColor(feeding.status),
                TIME_FORMAT.withZone(displayZone).format(feeding.createdAt),
                feeding.portionGrams.stripTrailingZeros().toPlainString(),
                feeding.actualGrams == null
                        ? null
                        : feeding.actualGrams.stripTrailingZeros().toPlainString(),
                formatError(feeding)
        );
    }

    private static int statusText(Feeding.Status status) {
        return switch (status) {
            case PENDING -> R.string.feeding_status_pending;
            case RUNNING -> R.string.feeding_status_running;
            case COMPLETED -> R.string.feeding_status_completed;
            case FAILED -> R.string.feeding_status_failed;
            case EXPIRED -> R.string.feeding_status_expired;
        };
    }

    private static int statusColor(Feeding.Status status) {
        return switch (status) {
            case PENDING, RUNNING -> R.color.status_busy;
            case COMPLETED -> R.color.status_online;
            case FAILED -> R.color.error;
            case EXPIRED -> R.color.text_secondary;
        };
    }

    private static String formatError(Feeding feeding) {
        if (feeding.errorCode == null) {
            return null;
        }
        return feeding.errorMessage == null
                ? feeding.errorCode
                : feeding.errorCode + " — " + feeding.errorMessage;
    }
}
