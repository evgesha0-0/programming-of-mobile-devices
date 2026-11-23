package ru.smartcatfeeder;

/** Верхнеуровневые экраны Android-клиента со стабильными ключами восстановления. */
public enum AppScreen {
    CONNECTION(
            "connection",
            R.id.navigation_connection,
            R.string.screen_connection_title,
            R.string.screen_connection_placeholder
    ),
    DEVICE_STATE(
            "device_state",
            R.id.navigation_device_state,
            R.string.screen_device_state_title,
            R.string.screen_device_state_placeholder
    ),
    SCHEDULES(
            "schedules",
            R.id.navigation_schedules,
            R.string.screen_schedules_title,
            R.string.screen_schedules_placeholder
    ),
    HISTORY(
            "history",
            R.id.navigation_history,
            R.string.screen_history_title,
            R.string.screen_history_placeholder
    );

    public final String key;
    public final int navigationViewId;
    public final int titleResource;
    public final int placeholderResource;

    AppScreen(
            String key,
            int navigationViewId,
            int titleResource,
            int placeholderResource
    ) {
        this.key = key;
        this.navigationViewId = navigationViewId;
        this.titleResource = titleResource;
        this.placeholderResource = placeholderResource;
    }

    public static AppScreen fromKey(String key) {
        for (AppScreen screen : values()) {
            if (screen.key.equals(key)) {
                return screen;
            }
        }
        return CONNECTION;
    }
}
