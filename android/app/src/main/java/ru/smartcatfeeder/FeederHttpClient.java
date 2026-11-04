package ru.smartcatfeeder;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Objects;

/** Синхронный HTTP-клиент. Все вызовы должны выполняться вне главного потока. */
public final class FeederHttpClient {
    static final int MAX_RESPONSE_BYTES = 1024 * 1024;
    private static final int CONNECT_TIMEOUT_MILLIS = 10_000;
    private static final int READ_TIMEOUT_MILLIS = 15_000;

    private final ConnectionSettings settings;

    public FeederHttpClient(ConnectionSettings settings) {
        this.settings = Objects.requireNonNull(settings, "settings");
    }

    public JSONObject execute(Method method, String resource, JSONObject requestBody)
            throws IOException {
        Objects.requireNonNull(method, "method");
        String safeResource = validateResource(resource);
        if (!method.allowsRequestBody && requestBody != null) {
            throw new IllegalArgumentException(method.name() + " не поддерживает тело запроса");
        }

        URL url = new URL(settings.serverBaseUrl + settings.devicePath() + safeResource);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setRequestMethod(method.name());
            connection.setConnectTimeout(CONNECT_TIMEOUT_MILLIS);
            connection.setReadTimeout(READ_TIMEOUT_MILLIS);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + settings.accessToken);

            if (requestBody != null) {
                byte[] bytes = requestBody.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream output = connection.getOutputStream()) {
                    output.write(bytes);
                }
            }

            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                closeQuietly(connection.getErrorStream());
                throw new ApiException(status);
            }

            String contentType = connection.getContentType();
            if (contentType == null
                    || !contentType.toLowerCase(Locale.ROOT).startsWith("application/json")) {
                closeQuietly(connection.getInputStream());
                throw new IOException("Ответ сервера не является JSON");
            }

            String response = readResponse(connection.getInputStream());
            try {
                return new JSONObject(response);
            } catch (JSONException error) {
                throw new IOException("Ответ сервера содержит некорректный JSON");
            }
        } finally {
            connection.disconnect();
        }
    }

    static String readResponse(InputStream input) throws IOException {
        if (input == null) {
            throw new IOException("Сервер вернул пустой ответ");
        }
        try (InputStream stream = input;
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                if (output.size() + count > MAX_RESPONSE_BYTES) {
                    throw new IOException("Ответ сервера слишком большой");
                }
                output.write(buffer, 0, count);
            }
            if (output.size() == 0) {
                throw new IOException("Сервер вернул пустой ответ");
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String validateResource(String resource) {
        String value = resource == null ? "" : resource.trim();
        if (value.isEmpty() || value.chars().anyMatch(character -> character <= 0x20)) {
            throw new IllegalArgumentException("Некорректный путь API");
        }
        try {
            URI uri = new URI(value);
            String path = uri.getRawPath();
            if (uri.isAbsolute()
                    || uri.getRawAuthority() != null
                    || uri.getRawFragment() != null
                    || path == null
                    || !path.startsWith("/")
                    || path.startsWith("//")
                    || !path.equals(uri.normalize().getRawPath())
                    || containsDotSegment(uri.getPath())) {
                throw new IllegalArgumentException("Некорректный путь API");
            }
            return value;
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("Некорректный путь API", error);
        }
    }

    private static boolean containsDotSegment(String path) {
        for (String segment : path.split("/", -1)) {
            if (".".equals(segment) || "..".equals(segment)) {
                return true;
            }
        }
        return false;
    }

    private static void closeQuietly(InputStream input) {
        if (input == null) {
            return;
        }
        try {
            input.close();
        } catch (IOException ignored) {
            // Соединение всё равно будет закрыто в finally.
        }
    }

    public enum Method {
        GET(false),
        POST(true),
        PUT(true),
        DELETE(false);

        private final boolean allowsRequestBody;

        Method(boolean allowsRequestBody) {
            this.allowsRequestBody = allowsRequestBody;
        }
    }

    public static final class ApiException extends IOException {
        public final int status;

        ApiException(int status) {
            super(messageFor(status));
            this.status = status;
        }

        private static String messageFor(int status) {
            return switch (status) {
                case 400 -> "Проверьте отправленные данные (400)";
                case 401 -> "Токен доступа недействителен или истёк (401)";
                case 403 -> "Нет доступа к этой кормушке (403)";
                case 404 -> "Устройство или ресурс не найдены (404)";
                case 409 -> "Данные изменились, обновите экран (409)";
                case 429 -> "Слишком много запросов, попробуйте позже (429)";
                case 503 -> "Сервис временно недоступен (503)";
                default -> "Сервер вернул ошибку (" + status + ")";
            };
        }
    }
}
