package ru.smartcatfeeder;

import org.json.JSONObject;
import org.junit.Test;
import java.net.ServerSocket;
import java.net.Socket;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

public class FeederApiTest {
    private static final String DEVICE = "d6d174f4-e79f-49d1-9476-78bc99483752";

    @Test public void sendsAuthorizationAndExactCommandBody() throws Exception {
        try (TestServer server = new TestServer(202, "", "{\"status\":\"pending\"}")) {
            FeederApi api = new FeederApi(new ConnectionSettings(server.address(), DEVICE, "test-token", true));
            JSONObject command = ManualCommand.create("40", java.time.Instant.now());
            assertEquals("pending", api.request("POST", "/feeding-commands", command).getString("status"));
            server.finished.get(3, TimeUnit.SECONDS);
            assertTrue(server.headers.get().startsWith("POST /api/v1/devices/" + DEVICE + "/feeding-commands HTTP/1.1"));
            assertTrue(server.headers.get().contains("Authorization: Bearer test-token"));
            assertEquals(command.toString(), server.body.get());
        }
    }

    @Test public void rejectsRedirectWithoutForwardingToken() throws Exception {
        try (TestServer server = new TestServer(302, "Location: /unexpected\r\n", "")) {
            FeederApi api = new FeederApi(new ConnectionSettings(server.address(), DEVICE, "test-token", true));
            assertEquals(302, assertThrows(FeederApi.ApiException.class, () -> api.request("GET", "/state", null)).status);
            server.finished.get(3, TimeUnit.SECONDS);
        }
    }

    private static final class TestServer implements AutoCloseable {
        final ServerSocket socket = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"));
        final ExecutorService worker = Executors.newSingleThreadExecutor();
        final AtomicReference<String> headers = new AtomicReference<>();
        final AtomicReference<String> body = new AtomicReference<>();
        final Future<?> finished;

        TestServer(int status, String extraHeaders, String response) throws Exception {
            socket.setSoTimeout(3000);
            finished = worker.submit(() -> {
                try (Socket client = socket.accept()) {
                    client.setSoTimeout(3000);
                    BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                    StringBuilder received = new StringBuilder();
                    int length = 0;
                    String line;
                    while ((line = reader.readLine()) != null && !line.isEmpty()) {
                        received.append(line).append("\r\n");
                        if (line.toLowerCase(java.util.Locale.ROOT).startsWith("content-length:"))
                            length = Integer.parseInt(line.substring(line.indexOf(':') + 1).trim());
                    }
                    headers.set(received.toString());
                    char[] data = new char[length];
                    int offset = 0;
                    while (offset < length) {
                        int count = reader.read(data, offset, length - offset);
                        if (count < 0) throw new java.io.IOException("Incomplete request");
                        offset += count;
                    }
                    body.set(new String(data));
                    byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
                    client.getOutputStream().write(("HTTP/1.1 " + status + " Test\r\n"
                            + extraHeaders + "Content-Length: " + bytes.length
                            + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    client.getOutputStream().write(bytes);
                } catch (Exception error) { throw new RuntimeException(error); }
            });
        }
        String address() { return "http://127.0.0.1:" + socket.getLocalPort(); }
        @Override public void close() throws Exception { socket.close(); worker.shutdownNow(); }
    }
}
