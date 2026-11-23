package ru.smartcatfeeder;

import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.Objects;

/** Подготовленные для экрана значения состояния кормушки. */
public final class DeviceStateViewData {
    private static final DateTimeFormatter LAST_SEEN_FORMAT =
            DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm:ss z", Locale.ROOT);

    public final int statusTextResource;
    public final int statusColorResource;
    public final String lastSeen;
    public final String scheduleRevision;
    public final String errorDetails;

    private DeviceStateViewData(
            int statusTextResource,
            int statusColorResource,
            String lastSeen,
            String scheduleRevision,
            String errorDetails
    ) {
        this.statusTextResource = statusTextResource;
        this.statusColorResource = statusColorResource;
        this.lastSeen = lastSeen;
        this.scheduleRevision = scheduleRevision;
        this.errorDetails = errorDetails;
    }

    public static DeviceStateViewData from(DeviceState state, ZoneId displayZone) {
        Objects.requireNonNull(state, "state");
        Objects.requireNonNull(displayZone, "displayZone");
        return new DeviceStateViewData(
                statusText(state.status),
                statusColor(state.status),
                state.lastSeenAt == null
                        ? null
                        : LAST_SEEN_FORMAT.withZone(displayZone).format(state.lastSeenAt),
                Long.toString(state.scheduleRevision),
                formatError(state.lastError)
        );
    }

    private static int statusText(DeviceState.Status status) {
        return switch (status) {
            case ONLINE -> R.string.device_status_online;
            case BUSY -> R.string.device_status_busy;
            case ERROR -> R.string.device_status_error;
            case OFFLINE -> R.string.device_status_offline;
            case UNKNOWN -> R.string.device_status_unknown;
        };
    }

    private static int statusColor(DeviceState.Status status) {
        return switch (status) {
            case ONLINE -> R.color.status_online;
            case BUSY -> R.color.status_busy;
            case ERROR -> R.color.error;
            case OFFLINE, UNKNOWN -> R.color.text_secondary;
        };
    }

    private static String formatError(DeviceState.DeviceError error) {
        if (error == null) {
            return null;
        }
        return error.message == null ? error.code : error.code + " — " + error.message;
    }
}
