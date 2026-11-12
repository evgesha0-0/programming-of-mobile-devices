package ru.smartcatfeeder;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.text.InputType;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.TimePicker;
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
    private Future<?> screenRequest;
    private int screenRequestVersion;

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
        networkExecutor = Executors.newFixedThreadPool(2);

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
        cancelScreenRequest();
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
        cancelScreenRequest();
        FrameLayout container = findViewById(R.id.screen_content);
        container.removeAllViews();
        if (screen == AppScreen.CONNECTION) {
            showConnectionScreen(container);
        } else if (screen == AppScreen.DEVICE_STATE) {
            showDeviceStateScreen(container);
        } else if (screen == AppScreen.SCHEDULES) {
            showSchedulesScreen(container);
        } else if (screen == AppScreen.HISTORY) {
            showHistoryScreen(container);
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

        int requestVersion = ++screenRequestVersion;
        ConnectionSettings settings = connectionSession.requireSettings();
        screenRequest = networkExecutor.submit(() -> {
            try {
                DeviceState state = new FeederRepository(settings).getDeviceState();
                runOnUiThread(() -> showDeviceStateResult(content, state, requestVersion));
            } catch (IOException error) {
                runOnUiThread(() -> showDeviceStateFailure(content, requestVersion));
            }
        });
    }

    private void showDeviceStateResult(View content, DeviceState state, int requestVersion) {
        if (!canApplyScreenResult(content, requestVersion, AppScreen.DEVICE_STATE)) {
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
        if (!canApplyScreenResult(content, requestVersion, AppScreen.DEVICE_STATE)) {
            return;
        }
        content.findViewById(R.id.device_state_progress).setVisibility(View.GONE);
        TextView loadError = content.findViewById(R.id.device_state_load_error);
        loadError.setText(R.string.device_state_load_failed);
        loadError.setVisibility(View.VISIBLE);
        content.findViewById(R.id.device_state_refresh).setEnabled(true);
    }

    private void showSchedulesScreen(FrameLayout container) {
        View content = LayoutInflater.from(this)
                .inflate(R.layout.screen_schedules, container, false);
        container.addView(content);
        content.findViewById(R.id.schedules_add)
                .setOnClickListener(view -> showScheduleEditor(content, null));
        content.findViewById(R.id.schedules_refresh)
                .setOnClickListener(view -> loadSchedules(content));
        loadSchedules(content);
    }

    private void loadSchedules(View content) {
        content.findViewById(R.id.schedules_progress).setVisibility(View.VISIBLE);
        content.findViewById(R.id.schedules_load_error).setVisibility(View.GONE);
        content.findViewById(R.id.schedules_empty).setVisibility(View.GONE);
        content.findViewById(R.id.schedules_add).setEnabled(false);
        content.findViewById(R.id.schedules_refresh).setEnabled(false);

        int requestVersion = ++screenRequestVersion;
        ConnectionSettings settings = connectionSession.requireSettings();
        screenRequest = networkExecutor.submit(() -> {
            try {
                ScheduleList schedules = new FeederRepository(settings).getSchedules();
                runOnUiThread(() -> showSchedulesResult(content, schedules, requestVersion));
            } catch (IOException error) {
                runOnUiThread(() -> showSchedulesFailure(content, requestVersion));
            }
        });
    }

    private void showSchedulesResult(
            View content,
            ScheduleList schedules,
            int requestVersion
    ) {
        if (!canApplyScreenResult(content, requestVersion, AppScreen.SCHEDULES)) {
            return;
        }
        TextView revision = content.findViewById(R.id.schedules_revision);
        revision.setText(getString(
                R.string.schedules_revision,
                Long.toString(schedules.scheduleRevision)
        ));
        revision.setVisibility(View.VISIBLE);

        LinearLayout list = content.findViewById(R.id.schedules_list);
        list.removeAllViews();
        for (Schedule schedule : schedules.items) {
            addScheduleItem(content, list, schedule);
        }

        content.findViewById(R.id.schedules_progress).setVisibility(View.GONE);
        content.findViewById(R.id.schedules_load_error).setVisibility(View.GONE);
        content.findViewById(R.id.schedules_empty).setVisibility(
                schedules.items.isEmpty() ? View.VISIBLE : View.GONE
        );
        content.findViewById(R.id.schedules_add).setEnabled(true);
        content.findViewById(R.id.schedules_refresh).setEnabled(true);
    }

    private void addScheduleItem(View content, LinearLayout list, Schedule schedule) {
        ScheduleViewData data = ScheduleViewData.from(schedule);
        View item = LayoutInflater.from(this).inflate(R.layout.item_schedule, list, false);
        ((TextView) item.findViewById(R.id.schedule_time)).setText(data.time);

        TextView active = item.findViewById(R.id.schedule_active);
        active.setText(data.active ? R.string.schedule_active : R.string.schedule_inactive);
        active.setTextColor(getColor(data.active ? R.color.status_online : R.color.text_secondary));

        StringBuilder days = new StringBuilder();
        for (int resource : data.dayTextResources) {
            if (days.length() > 0) {
                days.append(", ");
            }
            days.append(getString(resource));
        }
        ((TextView) item.findViewById(R.id.schedule_days)).setText(days.toString());
        ((TextView) item.findViewById(R.id.schedule_timezone)).setText(
                getString(R.string.schedule_timezone, data.timezone)
        );
        ((TextView) item.findViewById(R.id.schedule_portion)).setText(
                getString(R.string.schedule_portion, data.portionGrams)
        );
        item.setOnClickListener(view -> showScheduleEditor(content, schedule));
        list.addView(item);
    }

    private void showSchedulesFailure(View content, int requestVersion) {
        if (!canApplyScreenResult(content, requestVersion, AppScreen.SCHEDULES)) {
            return;
        }
        content.findViewById(R.id.schedules_progress).setVisibility(View.GONE);
        TextView loadError = content.findViewById(R.id.schedules_load_error);
        loadError.setText(R.string.schedules_load_failed);
        loadError.setVisibility(View.VISIBLE);
        content.findViewById(R.id.schedules_add).setEnabled(true);
        content.findViewById(R.id.schedules_refresh).setEnabled(true);
    }

    private void showScheduleEditor(View content, Schedule schedule) {
        View form = LayoutInflater.from(this).inflate(R.layout.dialog_schedule, null, false);
        TimePicker time = form.findViewById(R.id.schedule_editor_time);
        time.setIs24HourView(true);
        CheckBox[] days = scheduleDayInputs(form);
        EditText timezone = form.findViewById(R.id.schedule_timezone_input);
        EditText portion = form.findViewById(R.id.schedule_portion_input);
        CheckBox active = form.findViewById(R.id.schedule_active_input);
        TextView error = form.findViewById(R.id.schedule_editor_error);

        if (schedule == null) {
            timezone.setText(ZoneId.systemDefault().getId());
        } else {
            time.setHour(schedule.timeLocal.getHour());
            time.setMinute(schedule.timeLocal.getMinute());
            setSelectedScheduleDays(days, schedule.daysOfWeek);
            timezone.setText(schedule.timezone.getId());
            portion.setText(schedule.portionGrams.stripTrailingZeros().toPlainString());
            active.setChecked(schedule.active);
        }

        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle(schedule == null
                        ? R.string.schedule_editor_create_title
                        : R.string.schedule_editor_update_title)
                .setView(form)
                .setPositiveButton(R.string.schedule_editor_save, null)
                .setNegativeButton(R.string.schedule_editor_cancel, null);
        if (schedule != null) {
            builder.setNeutralButton(
                    R.string.schedule_editor_delete,
                    (dialog, which) -> confirmScheduleDeletion(content, schedule)
            );
        }

        AlertDialog dialog = builder.create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(view -> {
                    boolean[] selectedDays = new boolean[days.length];
                    for (int index = 0; index < days.length; index++) {
                        selectedDays[index] = days[index].isChecked();
                    }

                    ScheduleRequest request;
                    try {
                        request = ScheduleEditorInput.toRequest(
                                time.getHour(),
                                time.getMinute(),
                                selectedDays,
                                timezone.getText().toString(),
                                portion.getText().toString(),
                                active.isChecked()
                        );
                    } catch (IllegalArgumentException validationError) {
                        error.setText(validationError.getMessage());
                        error.setVisibility(View.VISIBLE);
                        return;
                    }

                    dialog.dismiss();
                    if (schedule == null) {
                        runScheduleMutation(
                                content,
                                repository -> repository.createSchedule(request),
                                R.string.schedule_created
                        );
                    } else {
                        runScheduleMutation(
                                content,
                                repository -> repository.updateSchedule(
                                        schedule.scheduleId,
                                        request
                                ),
                                R.string.schedule_updated
                        );
                    }
                }));
        dialog.show();
    }

    private void confirmScheduleDeletion(View content, Schedule schedule) {
        new AlertDialog.Builder(this)
                .setTitle(R.string.schedule_delete_title)
                .setMessage(R.string.schedule_delete_message)
                .setPositiveButton(
                        R.string.schedule_editor_delete,
                        (dialog, which) -> runScheduleMutation(
                                content,
                                repository -> repository.deleteSchedule(schedule.scheduleId),
                                R.string.schedule_deleted
                        )
                )
                .setNegativeButton(R.string.schedule_editor_cancel, null)
                .show();
    }

    private void runScheduleMutation(
            View content,
            ScheduleMutation mutation,
            int successMessage
    ) {
        cancelScreenRequest();
        content.findViewById(R.id.schedules_progress).setVisibility(View.VISIBLE);
        content.findViewById(R.id.schedules_load_error).setVisibility(View.GONE);
        content.findViewById(R.id.schedules_add).setEnabled(false);
        content.findViewById(R.id.schedules_refresh).setEnabled(false);

        int requestVersion = ++screenRequestVersion;
        ConnectionSettings settings = connectionSession.requireSettings();
        screenRequest = networkExecutor.submit(() -> {
            try {
                mutation.execute(new FeederRepository(settings));
                runOnUiThread(() -> {
                    if (!canApplyScreenResult(
                            content,
                            requestVersion,
                            AppScreen.SCHEDULES
                    )) {
                        return;
                    }
                    Toast.makeText(this, successMessage, Toast.LENGTH_SHORT).show();
                    loadSchedules(content);
                });
            } catch (IOException error) {
                runOnUiThread(() -> showScheduleMutationFailure(content, requestVersion));
            }
        });
    }

    private void showScheduleMutationFailure(View content, int requestVersion) {
        if (!canApplyScreenResult(content, requestVersion, AppScreen.SCHEDULES)) {
            return;
        }
        content.findViewById(R.id.schedules_progress).setVisibility(View.GONE);
        TextView loadError = content.findViewById(R.id.schedules_load_error);
        loadError.setText(R.string.schedule_change_failed);
        loadError.setVisibility(View.VISIBLE);
        content.findViewById(R.id.schedules_add).setEnabled(true);
        content.findViewById(R.id.schedules_refresh).setEnabled(true);
    }

    private void showHistoryScreen(FrameLayout container) {
        View content = LayoutInflater.from(this)
                .inflate(R.layout.screen_history, container, false);
        container.addView(content);
        FeedingHistoryState state = new FeedingHistoryState();
        content.findViewById(R.id.history_refresh)
                .setOnClickListener(view -> loadHistory(content, state, true));
        content.findViewById(R.id.history_load_more)
                .setOnClickListener(view -> loadHistory(content, state, false));
        loadHistory(content, state, true);
    }

    private void loadHistory(View content, FeedingHistoryState state, boolean firstPage) {
        String cursor = firstPage ? null : state.nextCursor();
        if (!firstPage && cursor == null) {
            return;
        }

        cancelScreenRequest();
        content.findViewById(R.id.history_progress).setVisibility(View.VISIBLE);
        content.findViewById(R.id.history_load_error).setVisibility(View.GONE);
        content.findViewById(R.id.history_empty).setVisibility(View.GONE);
        content.findViewById(R.id.history_load_more).setEnabled(false);
        content.findViewById(R.id.history_refresh).setEnabled(false);

        int requestVersion = ++screenRequestVersion;
        ConnectionSettings settings = connectionSession.requireSettings();
        screenRequest = networkExecutor.submit(() -> {
            try {
                FeedingHistoryPage page = new FeederRepository(settings)
                        .getFeedingHistory(50, cursor);
                runOnUiThread(() -> showHistoryResult(
                        content,
                        state,
                        page,
                        firstPage,
                        requestVersion
                ));
            } catch (IOException error) {
                runOnUiThread(() -> showHistoryFailure(content, state, requestVersion));
            }
        });
    }

    private void showHistoryResult(
            View content,
            FeedingHistoryState state,
            FeedingHistoryPage page,
            boolean firstPage,
            int requestVersion
    ) {
        if (!canApplyScreenResult(content, requestVersion, AppScreen.HISTORY)) {
            return;
        }
        if (firstPage) {
            state.applyFirstPage(page);
        } else {
            state.appendPage(page);
        }
        renderHistory(content, state);
    }

    private void renderHistory(View content, FeedingHistoryState state) {
        LinearLayout list = content.findViewById(R.id.history_list);
        list.removeAllViews();
        for (Feeding feeding : state.items()) {
            addFeedingItem(list, FeedingViewData.from(feeding, ZoneId.systemDefault()));
        }

        boolean empty = state.items().isEmpty();
        content.findViewById(R.id.history_progress).setVisibility(View.GONE);
        content.findViewById(R.id.history_load_error).setVisibility(View.GONE);
        content.findViewById(R.id.history_empty).setVisibility(
                empty ? View.VISIBLE : View.GONE
        );
        View loadMore = content.findViewById(R.id.history_load_more);
        loadMore.setVisibility(state.hasMore() ? View.VISIBLE : View.GONE);
        loadMore.setEnabled(true);
        content.findViewById(R.id.history_refresh).setEnabled(true);
    }

    private void addFeedingItem(LinearLayout list, FeedingViewData data) {
        View item = LayoutInflater.from(this).inflate(R.layout.item_feeding, list, false);
        ((TextView) item.findViewById(R.id.feeding_created_at)).setText(data.createdAt);
        ((TextView) item.findViewById(R.id.feeding_source)).setText(data.sourceTextResource);

        TextView status = item.findViewById(R.id.feeding_status);
        status.setText(data.statusTextResource);
        status.setTextColor(getColor(data.statusColorResource));
        ((TextView) item.findViewById(R.id.feeding_portion)).setText(
                getString(R.string.feeding_portion, data.portionGrams)
        );

        TextView actual = item.findViewById(R.id.feeding_actual);
        if (data.actualGrams == null) {
            actual.setVisibility(View.GONE);
        } else {
            actual.setText(getString(R.string.feeding_actual, data.actualGrams));
            actual.setVisibility(View.VISIBLE);
        }

        TextView feedingError = item.findViewById(R.id.feeding_error);
        if (data.errorDetails == null) {
            feedingError.setVisibility(View.GONE);
        } else {
            feedingError.setText(data.errorDetails);
            feedingError.setVisibility(View.VISIBLE);
        }
        list.addView(item);
    }

    private void showHistoryFailure(
            View content,
            FeedingHistoryState state,
            int requestVersion
    ) {
        if (!canApplyScreenResult(content, requestVersion, AppScreen.HISTORY)) {
            return;
        }
        content.findViewById(R.id.history_progress).setVisibility(View.GONE);
        content.findViewById(R.id.history_load_error).setVisibility(View.VISIBLE);
        View loadMore = content.findViewById(R.id.history_load_more);
        loadMore.setVisibility(state.hasMore() ? View.VISIBLE : View.GONE);
        loadMore.setEnabled(true);
        content.findViewById(R.id.history_refresh).setEnabled(true);
    }

    private static CheckBox[] scheduleDayInputs(View form) {
        return new CheckBox[]{
                form.findViewById(R.id.schedule_day_mon),
                form.findViewById(R.id.schedule_day_tue),
                form.findViewById(R.id.schedule_day_wed),
                form.findViewById(R.id.schedule_day_thu),
                form.findViewById(R.id.schedule_day_fri),
                form.findViewById(R.id.schedule_day_sat),
                form.findViewById(R.id.schedule_day_sun)
        };
    }

    private static void setSelectedScheduleDays(CheckBox[] inputs, java.util.List<String> days) {
        String[] values = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"};
        for (int index = 0; index < values.length; index++) {
            inputs[index].setChecked(days.contains(values[index]));
        }
    }

    private boolean canApplyScreenResult(
            View content,
            int requestVersion,
            AppScreen expectedScreen
    ) {
        return !isDestroyed()
                && content.isAttachedToWindow()
                && requestVersion == screenRequestVersion
                && navigator.currentScreen() == expectedScreen;
    }

    private void cancelScreenRequest() {
        screenRequestVersion++;
        if (screenRequest != null) {
            screenRequest.cancel(true);
            screenRequest = null;
        }
    }

    private interface ScheduleMutation {
        void execute(FeederRepository repository) throws IOException;
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
