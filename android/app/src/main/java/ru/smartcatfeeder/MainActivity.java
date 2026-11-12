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
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.time.ZoneId;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public final class MainActivity extends Activity {
    private static final String STATE_SCREEN = "selected_screen";
    private static final String CONNECTION_PREFERENCES = "connection";

    private ScreenNavigator navigator;
    private ConnectionSettingsStore connectionStore;
    private ConnectionSession connectionSession;
    private ExecutorService networkExecutor;
    private Future<?> deviceStateRequest;
    private int deviceStateRequestVersion;

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
        networkExecutor = Executors.newSingleThreadExecutor();

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

    @Override
    protected void onDestroy() {
        cancelDeviceStateRequest();
        networkExecutor.shutdownNow();
        super.onDestroy();
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
        cancelDeviceStateRequest();
        FrameLayout container = findViewById(R.id.screen_content);
        container.removeAllViews();
        if (screen == AppScreen.CONNECTION) {
            showConnectionScreen(container);
        } else if (screen == AppScreen.DEVICE_STATE) {
            showDeviceStateScreen(container);
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

    private void showDeviceStateScreen(FrameLayout container) {
        View content = LayoutInflater.from(this)
                .inflate(R.layout.screen_device_state, container, false);
        container.addView(content);
        content.findViewById(R.id.device_state_refresh)
                .setOnClickListener(view -> loadDeviceState(content));
        loadDeviceState(content);
    }

    private void loadDeviceState(View content) {
        ProgressBar progress = content.findViewById(R.id.device_state_progress);
        TextView loadError = content.findViewById(R.id.device_state_load_error);
        Button refresh = content.findViewById(R.id.device_state_refresh);
        progress.setVisibility(View.VISIBLE);
        loadError.setVisibility(View.GONE);
        refresh.setEnabled(false);

        int requestVersion = ++deviceStateRequestVersion;
        ConnectionSettings settings = connectionSession.requireSettings();
        deviceStateRequest = networkExecutor.submit(() -> {
            try {
                DeviceState state = new FeederRepository(settings).getDeviceState();
                runOnUiThread(() -> showDeviceStateResult(content, state, requestVersion));
            } catch (IOException error) {
                runOnUiThread(() -> showDeviceStateFailure(content, requestVersion));
            }
        });
    }

    private void showDeviceStateResult(View content, DeviceState state, int requestVersion) {
        if (!canApplyDeviceStateResult(content, requestVersion)) {
            return;
        }
        DeviceStateViewData data = DeviceStateViewData.from(state, ZoneId.systemDefault());
        TextView status = content.findViewById(R.id.device_state_status);
        status.setText(data.statusTextResource);
        status.setTextColor(getColor(data.statusColorResource));

        TextView lastSeen = content.findViewById(R.id.device_state_last_seen);
        lastSeen.setText(data.lastSeen == null
                ? getString(R.string.device_state_never_seen)
                : data.lastSeen);
        ((TextView) content.findViewById(R.id.device_state_revision))
                .setText(data.scheduleRevision);

        View deviceErrorGroup = content.findViewById(R.id.device_state_device_error_group);
        if (data.errorDetails == null) {
            deviceErrorGroup.setVisibility(View.GONE);
        } else {
            deviceErrorGroup.setVisibility(View.VISIBLE);
            ((TextView) content.findViewById(R.id.device_state_device_error))
                    .setText(data.errorDetails);
        }

        content.findViewById(R.id.device_state_progress).setVisibility(View.GONE);
        content.findViewById(R.id.device_state_content).setVisibility(View.VISIBLE);
        content.findViewById(R.id.device_state_load_error).setVisibility(View.GONE);
        content.findViewById(R.id.device_state_refresh).setEnabled(true);
    }

    private void showDeviceStateFailure(View content, int requestVersion) {
        if (!canApplyDeviceStateResult(content, requestVersion)) {
            return;
        }
        content.findViewById(R.id.device_state_progress).setVisibility(View.GONE);
        TextView loadError = content.findViewById(R.id.device_state_load_error);
        loadError.setText(R.string.device_state_load_failed);
        loadError.setVisibility(View.VISIBLE);
        content.findViewById(R.id.device_state_refresh).setEnabled(true);
    }

    private boolean canApplyDeviceStateResult(View content, int requestVersion) {
        return !isDestroyed()
                && content.isAttachedToWindow()
                && requestVersion == deviceStateRequestVersion
                && navigator.currentScreen() == AppScreen.DEVICE_STATE;
    }

    private void cancelDeviceStateRequest() {
        deviceStateRequestVersion++;
        if (deviceStateRequest != null) {
            deviceStateRequest.cancel(true);
            deviceStateRequest = null;
        }
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
