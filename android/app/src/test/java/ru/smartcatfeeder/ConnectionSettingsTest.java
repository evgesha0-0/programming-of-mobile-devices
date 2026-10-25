package ru.smartcatfeeder;

import org.junit.Test;
import static org.junit.Assert.*;

public class ConnectionSettingsTest {
    private static final String DEVICE = "d6d174f4-e79f-49d1-9476-78bc99483752";

    @Test public void canonicalSettingsAndDevicePath() {
        ConnectionSettings settings = new ConnectionSettings(" https://example.org/ ", DEVICE.toUpperCase(), " session-token ", false);
        assertEquals("https://example.org", settings.server);
        assertEquals("/api/v1/devices/" + DEVICE, settings.devicePath());
        assertEquals("session-token", settings.token);
    }

    @Test public void debugAllowsOnlyLocalCleartext() {
        new ConnectionSettings("http://10.0.2.2:3000", DEVICE, "session-token", true);
        assertThrows(IllegalArgumentException.class, () -> new ConnectionSettings("http://example.org", DEVICE, "session-token", true));
        assertThrows(IllegalArgumentException.class, () -> new ConnectionSettings("http://10.0.2.2:3000", DEVICE, "session-token", false));
    }

    @Test public void rejectsPathsCredentialsAndHeaderInjection() {
        for (String server : new String[]{"https://example.org/api/v1", "https://user:password@example.org", "https://example.org?key=value", "https://example.org:99999"}) {
            assertThrows(server, IllegalArgumentException.class, () -> new ConnectionSettings(server, DEVICE, "session-token", false));
        }
        assertThrows(IllegalArgumentException.class, () -> new ConnectionSettings("https://example.org", DEVICE, "token\r\nother", false));
        assertThrows(IllegalArgumentException.class, () -> new ConnectionSettings("https://example.org", "1-1-1-1-1", "token", false));
    }
}
