package ru.smartcatfeeder;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.UUID;

/** Проверенные параметры подключения Android-клиента к backend. */
public final class ConnectionSettings {
    private static final String EMULATOR_HOST = "10.0.2.2";

    public final String serverBaseUrl;
    public final String deviceId;
    public final String accessToken;

    public ConnectionSettings(
            String serverBaseUrl,
            String deviceId,
            String accessToken,
            boolean allowLocalCleartext
    ) {
        this.serverBaseUrl = validateServer(serverBaseUrl, allowLocalCleartext);
        this.deviceId = validateDeviceId(deviceId);
        this.accessToken = validateAccessToken(accessToken);
    }

    public String devicePath() {
        return "/api/v1/devices/" + deviceId;
    }

    public String storageKey() {
        return serverBaseUrl + "|" + deviceId;
    }

    private static String validateServer(String input, boolean allowLocalCleartext) {
        String value = requireText(input, "Введите адрес сервера");
        URI uri;
        try {
            uri = new URI(value);
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("Проверьте адрес сервера", error);
        }

        String scheme = uri.getScheme() == null
                ? ""
                : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost() == null
                ? ""
                : uri.getHost().toLowerCase(Locale.ROOT);
        boolean localHost = "localhost".equals(host)
                || "127.0.0.1".equals(host)
                || EMULATOR_HOST.equals(host);
        boolean acceptedScheme = "https".equals(scheme)
                || allowLocalCleartext && localHost && "http".equals(scheme);
        String path = uri.getPath();
        int port = uri.getPort();

        if (!acceptedScheme
                || host.isEmpty()
                || uri.isOpaque()
                || uri.getUserInfo() != null
                || uri.getQuery() != null
                || uri.getFragment() != null
                || path != null && !path.isEmpty() && !"/".equals(path)
                || port == 0
                || port > 65535) {
            throw new IllegalArgumentException(
                    "Укажите HTTPS-адрес без пути; в debug разрешён HTTP только для локального сервера"
            );
        }

        try {
            return new URI(scheme, null, host, port, null, null, null).toString();
        } catch (URISyntaxException impossible) {
            throw new IllegalArgumentException("Проверьте адрес сервера", impossible);
        }
    }

    private static String validateDeviceId(String input) {
        String value = requireText(input, "Введите UUID кормушки").toLowerCase(Locale.ROOT);
        try {
            if (!UUID.fromString(value).toString().equals(value)) {
                throw new IllegalArgumentException();
            }
            return value;
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Идентификатор кормушки должен быть UUID");
        }
    }

    private static String validateAccessToken(String input) {
        String value = requireText(input, "Введите токен доступа");
        if (value.chars().anyMatch(character -> character <= 0x1F || character == 0x7F)) {
            throw new IllegalArgumentException("Токен доступа содержит недопустимые символы");
        }
        return value;
    }

    private static String requireText(String input, String message) {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException(message);
        }
        return value;
    }
}
