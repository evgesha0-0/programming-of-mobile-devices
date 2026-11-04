package ru.smartcatfeeder;

import org.json.JSONObject;
import org.junit.Test;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public final class FeederHttpClientTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";

    @Test
    public void sendsExactAuthenticatedJsonRequest() throws Exception {
        try (TestServer server = TestServer.json(202, "{\"status\":\"pending\"}")) {
            FeederHttpClient client = client(server);
            JSONObject body = new JSONObject()
                    .put("command_id", "1875723f-f6e1-4307-92c8-81577f1ea2fb")
                    .put("portion_grams", 40);

            JSONObject response = client.execute(
                    FeederHttpClient.Method.POST,
                    "/feeding-commands",
                    body
            );

            assertEquals("pending", response.getString("status"));
            server.await();
            assertEquals(
                    "POST /api/v1/devices/" + DEVICE_ID + "/feeding-commands HTTP/1.1",
                    server.requestLine.get()
            );
            assertTrue(server.headers.get().contains("Authorization: Bearer test-token"));
            assertTrue(server.headers.get().contains("Accept: application/json"));
            assertTrue(server.headers.get().contains("Content-Type: application/json; charset=utf-8"));
            assertEquals(body.toString(), server.requestBody.get());
        }
    }

    @Test
    public void preservesEncodedQueryInGetRequest() throws Exception {
        try (TestServer server = TestServer.json(200, "{\"items\":[]}")) {
            FeederHttpClient client = client(server);

            client.execute(
                    FeederHttpClient.Method.GET,
                    "/feedings?limit=50&cursor=next%20page",
                    null
            );

            server.await();
            assertEquals(
                    "GET /api/v1/devices/" + DEVICE_ID
                            + "/feedings?limit=50&cursor=next%20page HTTP/1.1",
                    server.requestLine.get()
            );
            assertEquals("", server.requestBody.get());
        }
    }

    @Test
    public void mapsApiErrorsWithoutExposingResponseBody() throws Exception {
        for (int status : new int[]{400, 401, 403, 404, 409, 429, 500, 503}) {
            try (TestServer server = TestServer.json(
                    status,
                    "{\"error\":{\"message\":\"secret server detail\"}}"
            )) {
                FeederHttpClient.ApiException error = assertThrows(
                        FeederHttpClient.ApiException.class,
                        () -> client(server).execute(FeederHttpClient.Method.GET, "/state", null)
                );

                assertEquals(status, error.status);
                assertTrue(error.getMessage().contains(Integer.toString(status)));
                assertFalse(error.getMessage().contains("secret server detail"));
                server.await();
            }
        }
    }

    @Test
    public void rejectsRedirectWithoutForwardingToken() throws Exception {
        try (TestServer server = new TestServer(
                302,
                "Location: /unexpected\r\nContent-Type: application/json\r\n",
                "{}"
        )) {
            FeederHttpClient.ApiException error = assertThrows(
                    FeederHttpClient.ApiException.class,
                    () -> client(server).execute(FeederHttpClient.Method.GET, "/state", null)
            );

            assertEquals(302, error.status);
            server.await();
            assertEquals(1, server.acceptedConnections);
        }
    }

    @Test
    public void rejectsInvalidOrUnexpectedSuccessfulResponse() throws Exception {
        try (TestServer server = TestServer.json(200, "not-json")) {
            IOException error = assertThrows(
                    IOException.class,
                    () -> client(server).execute(FeederHttpClient.Method.GET, "/state", null)
            );
            assertFalse(error.getMessage().contains("not-json"));
            server.await();
        }

        try (TestServer server = new TestServer(200, "Content-Type: text/plain\r\n", "{}")) {
            assertThrows(
                    IOException.class,
                    () -> client(server).execute(FeederHttpClient.Method.GET, "/state", null)
            );
            server.await();
        }
    }

    @Test
    public void boundsResponseSizeAndRejectsEmptyBody() throws Exception {
        byte[] maximum = new byte[FeederHttpClient.MAX_RESPONSE_BYTES];
        assertEquals(
                FeederHttpClient.MAX_RESPONSE_BYTES,
                FeederHttpClient.readResponse(new ByteArrayInputStream(maximum)).length()
        );
        assertThrows(
                IOException.class,
                () -> FeederHttpClient.readResponse(new ByteArrayInputStream(new byte[0]))
        );
        assertThrows(
                IOException.class,
                () -> FeederHttpClient.readResponse(new ByteArrayInputStream(
                        new byte[FeederHttpClient.MAX_RESPONSE_BYTES + 1]
                ))
        );
    }

    @Test
    public void rejectsUnsafeResourceAndBodyCombinationBeforeNetworkCall() throws Exception {
        try (TestServer server = TestServer.json(200, "{}")) {
            FeederHttpClient client = client(server);
            for (String resource : new String[]{
                    "state",
                    "//example.org/state",
                    "/../state",
                    "/state#fragment",
                    "/state with-space"
            }) {
                assertThrows(
                        resource,
                        IllegalArgumentException.class,
                        () -> client.execute(FeederHttpClient.Method.GET, resource, null)
                );
            }
            assertThrows(
                    IllegalArgumentException.class,
                    () -> client.execute(
                            FeederHttpClient.Method.GET,
                            "/state",
                            new JSONObject()
                    )
            );
            assertEquals(0, server.acceptedConnections);
        }
    }

    private static FeederHttpClient client(TestServer server) {
        return new FeederHttpClient(new ConnectionSettings(
                server.address(),
                DEVICE_ID,
                "test-token",
                true
        ));
    }

    private static final class TestServer implements AutoCloseable {
        private final ServerSocket socket;
        private final ExecutorService worker = Executors.newSingleThreadExecutor();
        private final Future<?> finished;
        private final int status;
        private final String responseHeaders;
        private final byte[] responseBody;
        final AtomicReference<String> requestLine = new AtomicReference<>();
        final AtomicReference<String> headers = new AtomicReference<>();
        final AtomicReference<String> requestBody = new AtomicReference<>("");
        volatile int acceptedConnections;

        static TestServer json(int status, String responseBody) throws IOException {
            return new TestServer(
                    status,
                    "Content-Type: application/json; charset=utf-8\r\n",
                    responseBody
            );
        }

        TestServer(int status, String responseHeaders, String responseBody) throws IOException {
            this.socket = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"));
            this.socket.setSoTimeout(3000);
            this.status = status;
            this.responseHeaders = responseHeaders;
            this.responseBody = responseBody.getBytes(StandardCharsets.UTF_8);
            this.finished = worker.submit(this::serve);
        }

        String address() {
            return "http://127.0.0.1:" + socket.getLocalPort();
        }

        void await() throws Exception {
            finished.get(3, TimeUnit.SECONDS);
        }

        private void serve() {
            try (Socket client = socket.accept()) {
                acceptedConnections++;
                client.setSoTimeout(3000);
                BufferedReader reader = new BufferedReader(new InputStreamReader(
                        client.getInputStream(),
                        StandardCharsets.UTF_8
                ));
                requestLine.set(reader.readLine());
                StringBuilder capturedHeaders = new StringBuilder();
                int contentLength = 0;
                String line;
                while ((line = reader.readLine()) != null && !line.isEmpty()) {
                    capturedHeaders.append(line).append("\r\n");
                    if (line.toLowerCase(Locale.ROOT).startsWith("content-length:")) {
                        contentLength = Integer.parseInt(line.substring(line.indexOf(':') + 1).trim());
                    }
                }
                headers.set(capturedHeaders.toString());

                char[] body = new char[contentLength];
                int offset = 0;
                while (offset < contentLength) {
                    int count = reader.read(body, offset, contentLength - offset);
                    if (count < 0) {
                        throw new IOException("Неполное тело тестового запроса");
                    }
                    offset += count;
                }
                requestBody.set(new String(body));

                client.getOutputStream().write((
                        "HTTP/1.1 " + status + " Test\r\n"
                                + responseHeaders
                                + "Content-Length: " + responseBody.length + "\r\n"
                                + "Connection: close\r\n\r\n"
                ).getBytes(StandardCharsets.UTF_8));
                client.getOutputStream().write(responseBody);
            } catch (IOException error) {
                if (!socket.isClosed()) {
                    throw new RuntimeException(error);
                }
            }
        }

        @Override
        public void close() throws Exception {
            socket.close();
            worker.shutdownNow();
            worker.awaitTermination(3, TimeUnit.SECONDS);
        }
    }
}
