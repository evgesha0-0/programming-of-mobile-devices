package ru.smartcatfeeder;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import java.util.Objects;

/** Создаёт канал и показывает уведомления только о конечных результатах кормления. */
public final class FeedingNotifier {
    static final String CHANNEL_ID = "feeding_results";

    private final Context context;
    private final NotificationManager manager;

    public FeedingNotifier(Context context) {
        this.context = Objects.requireNonNull(context, "context").getApplicationContext();
        manager = Objects.requireNonNull(
                this.context.getSystemService(NotificationManager.class),
                "notificationManager"
        );
    }

    public void ensureChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.notification_channel_feeding_name),
                NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription(
                context.getString(R.string.notification_channel_feeding_description)
        );
        manager.createNotificationChannel(channel);
    }

    public boolean hasPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    public boolean notifyTerminal(Feeding feeding) {
        FeedingNotificationData data = FeedingNotificationData.from(feeding);
        if (!hasPermission()) {
            return false;
        }

        Intent intent = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                context,
                data.notificationId,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        String body = data.bodyArgument == null
                ? context.getString(data.bodyResource)
                : context.getString(data.bodyResource, data.bodyArgument);
        Notification notification = new Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(context.getString(data.titleResource))
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_STATUS)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .build();
        manager.notify(data.notificationId, notification);
        return true;
    }
}
