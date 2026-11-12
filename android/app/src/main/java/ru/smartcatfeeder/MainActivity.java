package ru.smartcatfeeder;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private static final String STATE_SCREEN = "selected_screen";

    private ScreenNavigator navigator;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        String restoredScreen = savedInstanceState == null
                ? null
                : savedInstanceState.getString(STATE_SCREEN);
        navigator = new ScreenNavigator(restoredScreen);
        bindNavigation();
        navigator.setListener(this::showScreen);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        outState.putString(STATE_SCREEN, navigator.savedScreenKey());
        super.onSaveInstanceState(outState);
    }

    private void bindNavigation() {
        for (AppScreen screen : AppScreen.values()) {
            findViewById(screen.navigationViewId).setOnClickListener(view -> navigator.select(screen));
        }
    }

    private void showScreen(AppScreen screen) {
        TextView title = findViewById(R.id.screen_title);
        TextView message = findViewById(R.id.screen_message);
        title.setText(screen.titleResource);
        message.setText(screen.placeholderResource);

        for (AppScreen item : AppScreen.values()) {
            View navigationView = findViewById(item.navigationViewId);
            boolean selected = item == screen;
            navigationView.setSelected(selected);
            navigationView.setAlpha(selected ? 1.0f : 0.55f);
        }
    }
}
