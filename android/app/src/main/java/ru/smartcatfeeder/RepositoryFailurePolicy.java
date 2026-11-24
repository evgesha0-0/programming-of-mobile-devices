package ru.smartcatfeeder;

import java.io.IOException;
import java.util.Objects;

/** Определяет, когда сетевой сбой требует повторного ввода пользовательского токена. */
public final class RepositoryFailurePolicy {
    private RepositoryFailurePolicy() {
    }

    public static Action actionFor(IOException error) {
        Objects.requireNonNull(error, "error");
        if (error instanceof FeederHttpClient.ApiException
                && ((FeederHttpClient.ApiException) error).status == 401) {
            return Action.REAUTHENTICATE;
        }
        return Action.SHOW_ERROR;
    }

    public enum Action {
        REAUTHENTICATE,
        SHOW_ERROR
    }
}
