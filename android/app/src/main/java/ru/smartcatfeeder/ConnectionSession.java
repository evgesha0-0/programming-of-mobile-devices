package ru.smartcatfeeder;

import java.util.Objects;

/** Держит полный набор подключения, включая токен, только в памяти процесса. */
public final class ConnectionSession {
    private ConnectionSettings settings;

    public boolean isConnected() {
        return settings != null;
    }

    public void connect(ConnectionSettings settings) {
        this.settings = Objects.requireNonNull(settings, "settings");
    }

    public ConnectionSettings requireSettings() {
        if (settings == null) {
            throw new IllegalStateException("Подключение не настроено");
        }
        return settings;
    }

    public void disconnect() {
        settings = null;
    }
}
