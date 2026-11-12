package ru.smartcatfeeder;

import java.util.Objects;

/** Хранит выбранный верхнеуровневый экран независимо от Android lifecycle. */
public final class ScreenNavigator {
    private AppScreen currentScreen;
    private Listener listener;

    public ScreenNavigator(String restoredScreenKey) {
        currentScreen = AppScreen.fromKey(restoredScreenKey);
    }

    public AppScreen currentScreen() {
        return currentScreen;
    }

    public String savedScreenKey() {
        return currentScreen.key;
    }

    public void setListener(Listener listener) {
        this.listener = Objects.requireNonNull(listener, "listener");
        listener.onScreenSelected(currentScreen);
    }

    public void select(AppScreen screen) {
        AppScreen selected = Objects.requireNonNull(screen, "screen");
        if (selected == currentScreen) {
            return;
        }
        currentScreen = selected;
        if (listener != null) {
            listener.onScreenSelected(selected);
        }
    }

    public interface Listener {
        void onScreenSelected(AppScreen screen);
    }
}
