package ru.smartcatfeeder;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public final class ApplicationConfigTest {
    @Test
    public void debugBuildUsesExpectedIdentity() {
        assertTrue(BuildConfig.DEBUG);
        assertEquals("ru.smartcatfeeder.debug", BuildConfig.APPLICATION_ID);
        assertEquals("0.1.0-debug", BuildConfig.VERSION_NAME);
    }
}
