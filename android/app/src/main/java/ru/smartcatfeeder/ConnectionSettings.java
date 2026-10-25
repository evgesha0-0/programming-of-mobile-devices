package ru.smartcatfeeder;

import java.net.URI;
import java.util.Locale;
import java.util.UUID;

public final class ConnectionSettings {
    public final String server;
    public final String device;
    public final String token;

    public ConnectionSettings(String server, String device, String token, boolean debug) {
        URI uri;
        try {
            uri = URI.create(server.trim());
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Проверьте адрес сервера");
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        boolean local = "localhost".equals(host) || "127.0.0.1".equals(host)
                || "10.0.2.2".equals(host);
        if (host == null || !("https".equals(scheme) || (debug && local && "http".equals(scheme)))
                || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                || (uri.getPath() != null && !uri.getPath().isEmpty() && !"/".equals(uri.getPath()))
                || uri.getPort() > 65535 || uri.getPort() == 0) {
            throw new IllegalArgumentException("Укажите HTTPS-адрес сервера без пути. В debug доступен HTTP локального сервера.");
        }
        String id = device.trim().toLowerCase(Locale.ROOT);
        try {
            if (!UUID.fromString(id).toString().equals(id)) throw new IllegalArgumentException();
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Идентификатор кормушки должен быть UUID");
        }
        String secret = token.trim();
        if (secret.isEmpty() || secret.contains("\r") || secret.contains("\n")) {
            throw new IllegalArgumentException("Введите токен доступа");
        }
        this.server = server.trim().replaceAll("/+$", "");
        this.device = id;
        this.token = secret;
    }

    public String storageKey() { return server + "/" + device; }
    public String devicePath() { return "/api/v1/devices/" + device; }
}
