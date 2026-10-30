package ru.smartcatfeeder;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;

public final class ConnectionSettingsTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";

    @Test
    public void canonicalizesValidConnection() {
        ConnectionSettings settings = new ConnectionSettings(
                " HTTPS://EXAMPLE.ORG/ ",
                DEVICE_ID.toUpperCase(),
                " access-token ",
                false
        );

        assertEquals("https://example.org", settings.serverBaseUrl);
        assertEquals(DEVICE_ID, settings.deviceId);
        assertEquals("access-token", settings.accessToken);
        assertEquals("/api/v1/devices/" + DEVICE_ID, settings.devicePath());
    }

    @Test
    public void storageKeySeparatesConnectionsAndNeverContainsToken() {
        ConnectionSettings first = settings("https://one.example", DEVICE_ID, "first-token", false);
        ConnectionSettings anotherServer = settings("https://two.example", DEVICE_ID, "first-token", false);
        ConnectionSettings anotherDevice = settings(
                "https://one.example",
                "ebc2fd74-7272-4c9e-a416-bdffde906913",
                "first-token",
                false
        );

        assertFalse(first.storageKey().equals(anotherServer.storageKey()));
        assertFalse(first.storageKey().equals(anotherDevice.storageKey()));
        assertFalse(first.storageKey().contains("first-token"));
    }

    @Test
    public void releaseAcceptsOnlyHttps() {
        settings("https://example.org", DEVICE_ID, "token", false);

        for (String server : new String[]{
                "http://example.org",
                "http://localhost:3000",
                "ftp://example.org",
                "example.org"
        }) {
            assertThrows(server, IllegalArgumentException.class,
                    () -> settings(server, DEVICE_ID, "token", false));
        }
    }

    @Test
    public void debugAllowsCleartextOnlyForKnownLocalHosts() {
        settings("http://localhost:3000", DEVICE_ID, "token", true);
        settings("http://127.0.0.1:3000", DEVICE_ID, "token", true);
        settings("http://10.0.2.2:3000", DEVICE_ID, "token", true);

        for (String server : new String[]{
                "http://example.org",
                "http://192.168.1.10:3000",
                "http://[::1]:3000"
        }) {
            assertThrows(server, IllegalArgumentException.class,
                    () -> settings(server, DEVICE_ID, "token", true));
        }
    }

    @Test
    public void rejectsServerMetadataAndApiPath() {
        for (String server : new String[]{
                "https://user:password@example.org",
                "https://example.org/api/v1",
                "https://example.org?token=value",
                "https://example.org#fragment",
                "https://example.org:0",
                "https://example.org:99999"
        }) {
            assertThrows(server, IllegalArgumentException.class,
                    () -> settings(server, DEVICE_ID, "token", false));
        }
    }

    @Test
    public void rejectsInvalidOrMissingDeviceId() {
        for (String deviceId : new String[]{"", "not-a-uuid", "1-1-1-1-1"}) {
            assertThrows(deviceId, IllegalArgumentException.class,
                    () -> settings("https://example.org", deviceId, "token", false));
        }
        assertThrows(IllegalArgumentException.class,
                () -> settings("https://example.org", null, "token", false));
    }

    @Test
    public void rejectsMissingTokenAndHeaderInjection() {
        for (String token : new String[]{"", "   ", "token\r\nX-Injected: value", "token\u0000value"}) {
            assertThrows(IllegalArgumentException.class,
                    () -> settings("https://example.org", DEVICE_ID, token, false));
        }
        assertThrows(IllegalArgumentException.class,
                () -> settings("https://example.org", DEVICE_ID, null, false));
    }

    private static ConnectionSettings settings(
            String server,
            String deviceId,
            String token,
            boolean allowLocalCleartext
    ) {
        return new ConnectionSettings(server, deviceId, token, allowLocalCleartext);
    }
}
