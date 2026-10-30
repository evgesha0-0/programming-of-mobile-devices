package ru.smartcatfeeder;

import android.content.SharedPreferences;

import java.util.Objects;

/** Хранит только несекретную часть подключения: адрес backend и UUID кормушки. */
public final class ConnectionSettingsStore {
    private static final String SERVER_KEY = "server_base_url";
    private static final String DEVICE_KEY = "device_id";
    private static final String VALIDATION_TOKEN = "not-persisted";

    private final Backend backend;
    private final boolean allowLocalCleartext;

    public ConnectionSettingsStore(
            SharedPreferences preferences,
            boolean allowLocalCleartext
    ) {
        this(new SharedPreferencesBackend(preferences), allowLocalCleartext);
    }

    ConnectionSettingsStore(Backend backend, boolean allowLocalCleartext) {
        this.backend = Objects.requireNonNull(backend, "backend");
        this.allowLocalCleartext = allowLocalCleartext;
    }

    public boolean save(ConnectionSettings settings) {
        Objects.requireNonNull(settings, "settings");
        return backend.save(settings.serverBaseUrl, settings.deviceId);
    }

    public SavedConnection load() {
        String server = backend.readServer();
        String device = backend.readDevice();
        if (server == null && device == null) {
            return null;
        }

        try {
            ConnectionSettings validated = new ConnectionSettings(
                    server,
                    device,
                    VALIDATION_TOKEN,
                    allowLocalCleartext
            );
            return new SavedConnection(validated.serverBaseUrl, validated.deviceId);
        } catch (IllegalArgumentException error) {
            backend.clear();
            return null;
        }
    }

    public boolean clear() {
        return backend.clear();
    }

    public static final class SavedConnection {
        public final String serverBaseUrl;
        public final String deviceId;

        private SavedConnection(String serverBaseUrl, String deviceId) {
            this.serverBaseUrl = serverBaseUrl;
            this.deviceId = deviceId;
        }
    }

    interface Backend {
        String readServer();

        String readDevice();

        boolean save(String serverBaseUrl, String deviceId);

        boolean clear();
    }

    private static final class SharedPreferencesBackend implements Backend {
        private final SharedPreferences preferences;

        private SharedPreferencesBackend(SharedPreferences preferences) {
            this.preferences = Objects.requireNonNull(preferences, "preferences");
        }

        @Override
        public String readServer() {
            return preferences.getString(SERVER_KEY, null);
        }

        @Override
        public String readDevice() {
            return preferences.getString(DEVICE_KEY, null);
        }

        @Override
        public boolean save(String serverBaseUrl, String deviceId) {
            return preferences.edit()
                    .putString(SERVER_KEY, serverBaseUrl)
                    .putString(DEVICE_KEY, deviceId)
                    .commit();
        }

        @Override
        public boolean clear() {
            return preferences.edit()
                    .remove(SERVER_KEY)
                    .remove(DEVICE_KEY)
                    .commit();
        }
    }
}
