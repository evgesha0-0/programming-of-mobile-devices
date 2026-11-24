package ru.smartcatfeeder;

import java.util.Objects;

/** Безопасное локализуемое содержимое уведомления о результате кормления. */
public final class FeedingNotificationData {
    public final int notificationId;
    public final int titleResource;
    public final int bodyResource;
    public final String bodyArgument;

    private FeedingNotificationData(
            int notificationId,
            int titleResource,
            int bodyResource,
            String bodyArgument
    ) {
        this.notificationId = notificationId;
        this.titleResource = titleResource;
        this.bodyResource = bodyResource;
        this.bodyArgument = bodyArgument;
    }

    public static FeedingNotificationData from(Feeding feeding) {
        Objects.requireNonNull(feeding, "feeding");
        int notificationId = feeding.feedingId.hashCode() & 0x7fffffff;
        if (notificationId == 0) {
            notificationId = 1;
        }
        return switch (feeding.status) {
            case COMPLETED -> new FeedingNotificationData(
                    notificationId,
                    R.string.notification_feeding_completed_title,
                    R.string.notification_feeding_completed_body,
                    feeding.actualGrams.stripTrailingZeros().toPlainString()
            );
            case FAILED -> new FeedingNotificationData(
                    notificationId,
                    R.string.notification_feeding_failed_title,
                    R.string.notification_feeding_failed_body,
                    feeding.errorMessage == null ? feeding.errorCode : feeding.errorMessage
            );
            case EXPIRED -> new FeedingNotificationData(
                    notificationId,
                    R.string.notification_feeding_expired_title,
                    R.string.notification_feeding_expired_body,
                    null
            );
            case PENDING, RUNNING -> throw new IllegalArgumentException(
                    "Уведомление возможно только для конечного результата"
            );
        };
    }
}
