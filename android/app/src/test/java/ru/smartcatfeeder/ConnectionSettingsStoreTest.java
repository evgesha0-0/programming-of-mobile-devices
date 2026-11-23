package ru.smartcatfeeder;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public final class ConnectionSettingsStoreTest {
    private static final String DEVICE_ID = "d6d174f4-e79f-49d1-9476-78bc99483752";

    @Test
    public void savesOnlyCanonicalServerAndDevice() {
        FakeBackend backend = new FakeBackend();
        ConnectionSettingsStore store = new ConnectionSettingsStore(backend, false);
        ConnectionSettings settings = new ConnectionSettings(
                "https://example.org/",
                DEVICE_ID,
                "secret-access-token",
                false
        );

        assertTrue(store.save(settings));

        assertEquals("https://example.org", backend.server);
        assertEquals(DEVICE_ID, backend.device);
        assertEquals(1, backend.saveCalls);
        assertFalse(backend.server.contains(settings.accessToken));
        assertFalse(backend.device.contains(settings.accessToken));
    }

    @Test
    public void loadsAndCanonicalizesValidSavedConnection() {
        FakeBackend backend = new FakeBackend();
        backend.server = "http://LOCALHOST:3000/";
        backend.device = DEVICE_ID.toUpperCase();
        ConnectionSettingsStore store = new ConnectionSettingsStore(backend, true);

        ConnectionSettingsStore.SavedConnection saved = store.load();

        assertNotNull(saved);
        assertEquals("http://localhost:3000", saved.serverBaseUrl);
        assertEquals(DEVICE_ID, saved.deviceId);
        assertEquals(0, backend.clearCalls);
    }

    @Test
    public void emptyStoreDoesNotPerformCleanup() {
        FakeBackend backend = new FakeBackend();
        ConnectionSettingsStore store = new ConnectionSettingsStore(backend, false);

        assertNull(store.load());
        assertEquals(0, backend.clearCalls);
    }

    @Test
    public void partialSavedConnectionIsRemoved() {
        FakeBackend backend = new FakeBackend();
        backend.server = "https://example.org";
        ConnectionSettingsStore store = new ConnectionSettingsStore(backend, false);

        assertNull(store.load());
        assertEquals(1, backend.clearCalls);
        assertNull(backend.server);
        assertNull(backend.device);
    }

    @Test
    public void invalidSavedConnectionIsRemoved() {
        FakeBackend backend = new FakeBackend();
        backend.server = "http://remote.example";
        backend.device = "not-a-uuid";
        ConnectionSettingsStore store = new ConnectionSettingsStore(backend, false);

        assertNull(store.load());
        assertEquals(1, backend.clearCalls);
        assertNull(backend.server);
        assertNull(backend.device);
    }

    @Test
    public void reportsPersistenceFailures() {
        FakeBackend backend = new FakeBackend();
        backend.saveResult = false;
        backend.clearResult = false;
        ConnectionSettingsStore store = new ConnectionSettingsStore(backend, false);
        ConnectionSettings settings = new ConnectionSettings(
                "https://example.org",
                DEVICE_ID,
                "token",
                false
        );

        assertFalse(store.save(settings));
        assertFalse(store.clear());
    }

    private static final class FakeBackend implements ConnectionSettingsStore.Backend {
        String server;
        String device;
        boolean saveResult = true;
        boolean clearResult = true;
        int saveCalls;
        int clearCalls;

        @Override
        public String readServer() {
            return server;
        }

        @Override
        public String readDevice() {
            return device;
        }

        @Override
        public boolean save(String serverBaseUrl, String deviceId) {
            saveCalls++;
            if (saveResult) {
                server = serverBaseUrl;
                device = deviceId;
            }
            return saveResult;
        }

        @Override
        public boolean clear() {
            clearCalls++;
            if (clearResult) {
                server = null;
                device = null;
            }
            return clearResult;
        }
    }
}
