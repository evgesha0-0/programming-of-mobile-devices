package ru.smartcatfeeder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class ScreenNavigatorTest {
    @Test
    public void unknownOrMissingStateOpensConnectionScreen() {
        assertEquals(AppScreen.CONNECTION, new ScreenNavigator(null).currentScreen());
        assertEquals(AppScreen.CONNECTION, new ScreenNavigator("unknown").currentScreen());
    }

    @Test
    public void restoresEveryScreenByStableUniqueKey() {
        Set<String> keys = new HashSet<>();

        for (AppScreen screen : AppScreen.values()) {
            assertEquals(screen, new ScreenNavigator(screen.key).currentScreen());
            keys.add(screen.key);
        }

        assertEquals(AppScreen.values().length, keys.size());
    }

    @Test
    public void notifiesListenerOnInitialAndChangedSelectionOnly() {
        ScreenNavigator navigator = new ScreenNavigator(AppScreen.DEVICE_STATE.key);
        List<AppScreen> notifications = new ArrayList<>();

        navigator.setListener(notifications::add);
        navigator.select(AppScreen.DEVICE_STATE);
        navigator.select(AppScreen.HISTORY);

        assertEquals(2, notifications.size());
        assertEquals(AppScreen.DEVICE_STATE, notifications.get(0));
        assertEquals(AppScreen.HISTORY, notifications.get(1));
        assertEquals(AppScreen.HISTORY.key, navigator.savedScreenKey());
    }

    @Test
    public void rejectsMissingListenerAndScreen() {
        ScreenNavigator navigator = new ScreenNavigator(null);

        assertThrows(NullPointerException.class, () -> navigator.setListener(null));
        assertThrows(NullPointerException.class, () -> navigator.select(null));
    }
}
