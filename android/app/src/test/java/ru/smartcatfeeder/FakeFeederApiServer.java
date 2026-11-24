package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/** Последовательный локальный HTTP-сервер для сквозных JVM-тестов Android-клиента. */
final class FakeFeederApiServer implements AutoCloseable {
    private final ServerSocket socket;
    private final String expectedAuthorization;
    private final List<Expectation> expectations = new ArrayList<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private Future<?> finished;

    FakeFeederApiServer(String accessToken) throws IOException {
        socket = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        socket.setSoTimeout(5000);
        expectedAuthorization = "Bearer " + accessToken;
    }

    String address() {
        return "http://127.0.0.1:" + socket.getLocalPort();
    }

    void enqueue(
            String method,
            String resource,
            String expectedBody,
            int responseStatus,
            String responseBody
    ) {
        if (finished != null) {
            throw new IllegalStateException("Сервер уже запущен");
        }
        expectations.add(new Expectation(
                method,
                resource,
                expectedBody,
                responseStatus,
                responseBody
        ));
    }

    void start() {
        if (finished != null) {
            throw new IllegalStateException("Сервер уже запущен");
        }
        finished = worker.submit(this::serveAll);
    }

    void await() throws Exception {
        if (finished == null) {
            throw new IllegalStateException("Сервер не запущен");
        }
        finished.get(10, TimeUnit.SECONDS);
    }

    private void serveAll() {
        try {
            for (Expectation expectation : expectations) {
                serve(expectation);
            }
        } catch (IOException error) {
            if (!socket.isClosed()) {
                throw new RuntimeException(error);
            }
        }
    }

    private void serve(Expectation expectation) throws IOException {
        try (Socket client = socket.accept()) {
            client.setSoTimeout(5000);
            BufferedReader reader = new BufferedReader(new InputStreamReader(
                    client.getInputStream(),
                    StandardCharsets.UTF_8
            ));
            String requestLine = reader.readLine();
            assertEquals(
                    expectation.method + " " + expectation.resource + " HTTP/1.1",
                    requestLine
            );

            int contentLength = 0;
            String authorization = null;
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                int separator = line.indexOf(':');
                if (separator < 0) {
                    continue;
                }
                String name = line.substring(0, separator).trim().toLowerCase(Locale.ROOT);
                String value = line.substring(separator + 1).trim();
                if ("content-length".equals(name)) {
                    contentLength = Integer.parseInt(value);
                } else if ("authorization".equals(name)) {
                    authorization = value;
                }
            }
            assertEquals(expectedAuthorization, authorization);

            char[] requestBody = new char[contentLength];
            int offset = 0;
            while (offset < contentLength) {
                int count = reader.read(requestBody, offset, contentLength - offset);
                if (count < 0) {
                    throw new IOException("Неполное тело тестового запроса");
                }
                offset += count;
            }
            String actualBody = new String(requestBody);
            if (expectation.expectedBody == null) {
                assertTrue(actualBody.isEmpty());
            } else {
                assertEquals(expectation.expectedBody, actualBody);
            }

            byte[] response = expectation.responseBody.getBytes(StandardCharsets.UTF_8);
            client.getOutputStream().write((
                    "HTTP/1.1 " + expectation.responseStatus + " Test\r\n"
                            + "Content-Type: application/json; charset=utf-8\r\n"
                            + "Content-Length: " + response.length + "\r\n"
                            + "Connection: close\r\n\r\n"
            ).getBytes(StandardCharsets.UTF_8));
            client.getOutputStream().write(response);
            client.getOutputStream().flush();
        }
    }

    @Override
    public void close() throws Exception {
        socket.close();
        worker.shutdownNow();
        worker.awaitTermination(5, TimeUnit.SECONDS);
    }

    private static final class Expectation {
        final String method;
        final String resource;
        final String expectedBody;
        final int responseStatus;
        final String responseBody;

        Expectation(
                String method,
                String resource,
                String expectedBody,
                int responseStatus,
                String responseBody
        ) {
            this.method = method;
            this.resource = resource;
            this.expectedBody = expectedBody;
            this.responseStatus = responseStatus;
            this.responseBody = responseBody;
        }
    }
}
