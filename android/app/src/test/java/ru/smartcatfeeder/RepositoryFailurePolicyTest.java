package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.io.IOException;

public final class RepositoryFailurePolicyTest {
    @Test
    public void unauthorizedResponseRequiresNewToken() {
        assertEquals(
                RepositoryFailurePolicy.Action.REAUTHENTICATE,
                RepositoryFailurePolicy.actionFor(new FeederHttpClient.ApiException(401))
        );
    }

    @Test
    public void forbiddenAndOtherFailuresStayOnCurrentScreen() {
        assertEquals(
                RepositoryFailurePolicy.Action.SHOW_ERROR,
                RepositoryFailurePolicy.actionFor(new FeederHttpClient.ApiException(403))
        );
        assertEquals(
                RepositoryFailurePolicy.Action.SHOW_ERROR,
                RepositoryFailurePolicy.actionFor(new IOException("offline"))
        );
    }
}
