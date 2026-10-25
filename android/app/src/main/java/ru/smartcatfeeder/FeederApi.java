package ru.smartcatfeeder;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Синхронный клиент. Вызывать только из фонового потока. */
public final class FeederApi {
    private final ConnectionSettings settings;

    public FeederApi(ConnectionSettings settings) { this.settings = settings; }

    public JSONObject request(String method, String suffix, JSONObject body) throws IOException, JSONException {
        HttpURLConnection connection = (HttpURLConnection) new URL(
                settings.server + settings.devicePath() + suffix).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(15000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + settings.token);
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            String text = read(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
            if (status < 200 || status >= 300) {
                // Не показываем сырое тело ошибки: там могут оказаться данные сервера.
                throw new ApiException(status);
            }
            return new JSONObject(text);
        } finally {
            connection.disconnect();
        }
    }

    private static String read(InputStream input) throws IOException {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                if (output.size() + count > 1024 * 1024) throw new IOException("Ответ сервера слишком большой");
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    public static final class ApiException extends IOException {
        public final int status;
        ApiException(int status) {
            super(switch (status) {
                case 400 -> "Проверьте введённые данные (400)";
                case 401 -> "Токен недействителен или истёк (401)";
                case 403 -> "Нет доступа к этой кормушке (403)";
                case 404 -> "Устройство или метод API пока не найдены (404)";
                case 409 -> "Данные изменились. Обновите экран (409)";
                case 429 -> "Слишком много запросов. Попробуйте позже (429)";
                default -> "Сервер недоступен или вернул ошибку (" + status + ")";
            });
            this.status = status;
        }
    }
}
