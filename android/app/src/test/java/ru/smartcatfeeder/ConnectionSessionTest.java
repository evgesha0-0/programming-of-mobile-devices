package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ConnectionSessionTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";

    @Test
    public void keepsValidatedConnectionOnlyInSessionObject() {
        ConnectionSettings settings = new ConnectionSettings(
                "https://example.org",
                DEVICE_ID,
                "secret-token",
                false
        );
        ConnectionSession session = new ConnectionSession();

        session.connect(settings);

        assertTrue(session.isConnected());
        assertEquals(settings, session.requireSettings());
        assertEquals("secret-token", session.requireSettings().accessToken);
    }

    @Test
    public void disconnectRemovesFullConnection() {
        ConnectionSession session = new ConnectionSession();
        session.connect(new ConnectionSettings(
                "https://example.org",
                DEVICE_ID,
                "secret-token",
                false
        ));

        session.disconnect();

        assertFalse(session.isConnected());
        assertThrows(IllegalStateException.class, session::requireSettings);
    }

    @Test
    public void rejectsMissingConnection() {
        ConnectionSession session = new ConnectionSession();

        assertThrows(NullPointerException.class, () -> session.connect(null));
        assertThrows(IllegalStateException.class, session::requireSettings);
    }
}
