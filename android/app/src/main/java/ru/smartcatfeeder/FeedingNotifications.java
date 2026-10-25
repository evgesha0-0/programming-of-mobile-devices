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

public final class FeedingNotifications {
    private static final String CHANNEL = "feeding_results";
    private FeedingNotifications() {}

    public static boolean enabled(Context context) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
        return manager.areNotificationsEnabled() && (channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE);
    }

    public static void show(Context context, String deviceKey, FeedingResult result) {
        if (!result.terminal() || !enabled(context)) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL,
                context.getString(R.string.notification_channel), NotificationManager.IMPORTANCE_DEFAULT));
        Intent intent = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent open = PendingIntent.getActivity(context, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String title = context.getString(switch (result.status) {
            case "completed" -> R.string.notification_completed;
            case "failed" -> R.string.notification_failed;
            default -> R.string.notification_expired;
        });
        String text = "completed".equals(result.status)
                ? context.getString(R.string.notification_mass, result.actualGrams.toPlainString())
                : context.getString("failed".equals(result.status) ? R.string.notification_error : R.string.notification_timeout);
        Notification notification = new Notification.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title).setContentText(text).setContentIntent(open)
                .setAutoCancel(true).setOnlyAlertOnce(true).build();
        try { manager.notify(deviceKey + "/" + result.feedingId, 0, notification); }
        catch (SecurityException ignored) { /* Разрешение могли отозвать между проверкой и отправкой. */ }
    }
}
