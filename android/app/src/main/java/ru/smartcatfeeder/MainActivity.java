package ru.smartcatfeeder;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private static final String STATE_SCREEN = "selected_screen";
    private static final String CONNECTION_PREFERENCES = "connection";

    private ScreenNavigator navigator;
    private ConnectionSettingsStore connectionStore;
    private ConnectionSession connectionSession;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        Object retained = getLastNonConfigurationInstance();
        connectionSession = retained instanceof ConnectionSession
                ? (ConnectionSession) retained
                : new ConnectionSession();
        connectionStore = new ConnectionSettingsStore(
                getSharedPreferences(CONNECTION_PREFERENCES, MODE_PRIVATE),
                BuildConfig.DEBUG
        );

        String restoredScreen = savedInstanceState == null || !connectionSession.isConnected()
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

    @Override
    public Object onRetainNonConfigurationInstance() {
        return connectionSession;
    }

    private void bindNavigation() {
        for (AppScreen screen : AppScreen.values()) {
            findViewById(screen.navigationViewId).setOnClickListener(view -> selectScreen(screen));
        }
    }

    private void selectScreen(AppScreen screen) {
        if (screen != AppScreen.CONNECTION && !connectionSession.isConnected()) {
            Toast.makeText(this, R.string.connection_required, Toast.LENGTH_SHORT).show();
            navigator.select(AppScreen.CONNECTION);
            return;
        }
        navigator.select(screen);
    }

    private void showScreen(AppScreen screen) {
        FrameLayout container = findViewById(R.id.screen_content);
        container.removeAllViews();
        if (screen == AppScreen.CONNECTION) {
            showConnectionScreen(container);
        } else {
            showPlaceholderScreen(container, screen);
        }

        for (AppScreen item : AppScreen.values()) {
            View navigationView = findViewById(item.navigationViewId);
            boolean selected = item == screen;
            navigationView.setSelected(selected);
            navigationView.setAlpha(selected ? 1.0f : 0.55f);
        }
    }

    private void showPlaceholderScreen(FrameLayout container, AppScreen screen) {
        View content = LayoutInflater.from(this)
                .inflate(R.layout.screen_placeholder, container, false);
        container.addView(content);
        TextView title = content.findViewById(R.id.screen_title);
        TextView message = content.findViewById(R.id.screen_message);
        title.setText(screen.titleResource);
        message.setText(screen.placeholderResource);
    }

    private void showConnectionScreen(FrameLayout container) {
        View content = LayoutInflater.from(this)
                .inflate(R.layout.screen_connection, container, false);
        container.addView(content);

        EditText serverInput = content.findViewById(R.id.server_input);
        EditText deviceIdInput = content.findViewById(R.id.device_id_input);
        EditText tokenInput = content.findViewById(R.id.access_token_input);
        CheckBox showToken = content.findViewById(R.id.show_token_checkbox);
        TextView errorView = content.findViewById(R.id.connection_error);
        Button clearButton = content.findViewById(R.id.clear_connection_button);

        ConnectionSettingsStore.SavedConnection saved = connectionStore.load();
        if (saved != null) {
            serverInput.setText(saved.serverBaseUrl);
            deviceIdInput.setText(saved.deviceId);
        }
        clearButton.setEnabled(saved != null || connectionSession.isConnected());

        showToken.setOnCheckedChangeListener((button, checked) -> {
            int variation = checked
                    ? InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                    : InputType.TYPE_TEXT_VARIATION_PASSWORD;
            tokenInput.setInputType(InputType.TYPE_CLASS_TEXT | variation);
            tokenInput.setSelection(tokenInput.length());
        });

        content.findViewById(R.id.connect_button).setOnClickListener(view -> {
            hideConnectionError(errorView);
            ConnectionSettings settings;
            try {
                settings = new ConnectionSettings(
                        serverInput.getText().toString(),
                        deviceIdInput.getText().toString(),
                        tokenInput.getText().toString(),
                        BuildConfig.DEBUG
                );
            } catch (IllegalArgumentException validationError) {
                showConnectionError(errorView, validationError.getMessage());
                return;
            }

            if (!connectionStore.save(settings)) {
                showConnectionError(errorView, getString(R.string.connection_save_error));
                return;
            }

            connectionSession.connect(settings);
            tokenInput.setText("");
            Toast.makeText(this, R.string.connection_saved, Toast.LENGTH_SHORT).show();
            navigator.select(AppScreen.DEVICE_STATE);
        });

        clearButton.setOnClickListener(view -> {
            hideConnectionError(errorView);
            if (!connectionStore.clear()) {
                showConnectionError(errorView, getString(R.string.connection_clear_error));
                return;
            }
            connectionSession.disconnect();
            serverInput.setText("");
            deviceIdInput.setText("");
            tokenInput.setText("");
            clearButton.setEnabled(false);
            Toast.makeText(this, R.string.connection_cleared, Toast.LENGTH_SHORT).show();
        });
    }

    private static void showConnectionError(TextView errorView, String message) {
        errorView.setText(message);
        errorView.setVisibility(View.VISIBLE);
    }

    private static void hideConnectionError(TextView errorView) {
        errorView.setText("");
        errorView.setVisibility(View.GONE);
    }
}
