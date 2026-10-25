package ru.smartcatfeeder;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.view.WindowInsets;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final List<View> controls = new ArrayList<>();
    private final List<View> navigationControls = new ArrayList<>();
    private SharedPreferences preferences;
    private ConnectionSettings connection;
    private LinearLayout root, content;
    private TextView notice;
    private boolean busy;
    private String page = "Кормушка";
    private String nextCursor;
    private final JSONArray history = new JSONArray();
    private final Handler pollingHandler = new Handler(Looper.getMainLooper());
    private FeedingPoller poller;
    private boolean visible;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("feeder", MODE_PRIVATE);
        Object retained = getLastNonConfigurationInstance();
        if (retained instanceof ConnectionSettings) connection = (ConnectionSettings) retained;
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(243, 246, 245));
        root.setPadding(dp(20), dp(16), dp(20), dp(12));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                view.setPadding(dp(20) + bars.left, dp(16) + bars.top,
                        dp(20) + bars.right, dp(12) + bars.bottom);
            } else {
                view.setPadding(dp(20) + insets.getSystemWindowInsetLeft(), dp(16) + insets.getSystemWindowInsetTop(),
                        dp(20) + insets.getSystemWindowInsetRight(), dp(12) + insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        setContentView(root);
        label(root, "SMART CAT FEEDER", 13, false);
        label(root, "Забота по расписанию", 27, true);
        notice = label(root, "Настройте подключение к вашей кормушке", 14, false);
        LinearLayout tabs = new LinearLayout(this);
        root.addView(tabs);
        for (String title : new String[]{"Кормушка", "Расписание", "История", "Связь"}) {
            Button tab = button(tabs, title, () -> { page = title; render(); });
            tab.setTextSize(11);
            tab.setPadding(0, 0, 0, 0);
            tab.setLayoutParams(new LinearLayout.LayoutParams(0, dp(52), 1));
        }
        navigationControls.addAll(controls);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(content);
        render();
    }

    @Override public Object onRetainNonConfigurationInstance() { return connection; }

    private void render() {
        clearContent();
        if (connection == null || page.equals("Связь")) { connectionForm(); return; }
        switch (page) {
            case "Расписание": schedulePage(); break;
            case "История": historyPage(); break;
            default: feederPage();
        }
    }

    private void connectionForm() {
        LinearLayout card = card("Подключение");
        label(card, "Адрес сервера и идентификатор выдаст участник, который делает backend.", 14, false);
        EditText server = input(card, "Адрес сервера", connection == null
                ? preferences.getString("server", "") : connection.server, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        EditText device = input(card, "UUID кормушки", connection == null
                ? preferences.getString("device", "") : connection.device, InputType.TYPE_CLASS_TEXT);
        EditText token = input(card, "Токен доступа", connection == null ? "" : connection.token,
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        token.setSaveEnabled(false);
        token.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        label(card, "Токен хранится только до закрытия приложения. Адрес и UUID сохраняются на телефоне.", 13, false);
        button(card, "Сохранить подключение", () -> {
            try {
                ConnectionSettings updated = new ConnectionSettings(server.getText().toString(),
                        device.getText().toString(), token.getText().toString(), BuildConfig.DEBUG);
                preferences.edit().putString("server", updated.server).putString("device", updated.device).apply();
                connection = updated;
                restartPendingMonitor();
                clearHistory();
                page = "Кормушка";
                notice.setText("Подключение сохранено. Нажмите «Обновить состояние».");
                render();
            } catch (IllegalArgumentException error) { showError(error.getMessage()); }
        });
    }

    private void feederPage() {
        LinearLayout status = card("Моя кормушка");
        TextView state = label(status, "Состояние ещё не запрошено", 19, true);
        TextView seen = label(status, "Последняя связь: —", 14, false);
        button(status, "Обновить состояние", () -> execute(() -> api().request("GET", "/state", null), response -> {
            state.setText(deviceStatus(response.getString("status")));
            seen.setText(getString(R.string.last_seen, value(response, "last_seen_at")));
            notice.setText(getString(R.string.server_updated, Instant.now().toString()));
            JSONObject error = response.optJSONObject("last_error");
            if (error != null) label(status, "Ошибка устройства: " + error.optString("code", "UNKNOWN"), 14, false);
        }));
        LinearLayout feeding = card("Ручное кормление");
        label(feeding, "Команда поступает на кормушку через сервер. Принятие команды ещё не означает выдачу корма.", 14, false);
        label(feeding, "Результат обновляется автоматически, пока приложение открыто. При сворачивании проверка приостанавливается.", 13, false);
        if (FeedingNotifications.enabled(this)) {
            label(feeding, "Уведомления о результате включены", 13, false);
        } else if (android.os.Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            button(feeding, "Включить уведомления", () -> requestPermissions(
                    new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 10));
        } else {
            label(feeding, "Системные уведомления выключены. Результат останется на экране.", 13, false);
        }
        String lastResult = preferences.getString("last-result:" + connection.storageKey(), null);
        if (lastResult != null) label(feeding, lastResult, 14, false);
        EditText grams = input(feeding, "Порция, г", "40", InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        button(feeding, "Выдать порцию", () -> {
            if (pending() != null) { showError("Сначала проверьте предыдущую команду"); return; }
            try {
                JSONObject command = ManualCommand.create(grams.getText().toString(), Instant.now());
                new AlertDialog.Builder(this).setTitle("Выдать " + command.get("portion_grams") + " г?")
                        .setMessage("Срок ожидания команды — 5 минут. Результат подтвердит кормушка.")
                        .setNegativeButton("Отмена", null).setPositiveButton("Отправить", (dialog, which) -> {
                            if (savePending(command)) sendCommand(command);
                        }).show();
            } catch (Exception error) { showError(error.getMessage()); }
        });
        JSONObject command = pending();
        if (command != null) {
            LinearLayout pendingCard = card("Текущая команда");
            if (!command.has("command_id") || !command.has("expires_at")) {
                label(pendingCard, "Не удалось прочитать команду. Новая подача заблокирована. Проверьте историю на сервере.", 14, false);
                return;
            }
            label(pendingCard, "Порция: " + command.opt("portion_grams") + " г\nСрок: " + command.optString("expires_at"), 14, false);
            String feedingId = command.optString("feeding_id");
            if (feedingId.isEmpty()) {
                label(pendingCard, "Подтверждение сервера ещё не получено. Повтор использует тот же идентификатор команды.", 14, false);
                button(pendingCard, "Повторить запрос", () -> sendCommand(command));
            } else {
                label(pendingCard, "Статус: " + feedingStatus(command.optString("status", "pending")), 17, true);
                button(pendingCard, "Проверить результат", () -> execute(
                        () -> api().request("GET", "/feedings/" + feedingId, null), result -> {
                            acceptFeedingResult(command, FeedingResult.parse(feedingId, command.getString("command_id"), result));
                        }));
            }
            if (Instant.parse(command.optString("expires_at")).isBefore(Instant.now())) {
                button(pendingCard, "Убрать команду с экрана", () -> new AlertDialog.Builder(this)
                        .setTitle("Убрать команду?")
                        .setMessage("Это не отменяет команду на сервере. Перед новой подачей проверьте историю, чтобы не выдать лишнюю порцию.")
                        .setNegativeButton("Оставить", null).setPositiveButton("Убрать", (dialog, which) -> {
                            preferences.edit().remove(pendingKey()).apply();
                            restartPendingMonitor(); render();
                        }).show());
            }
        }
    }

    private void sendCommand(JSONObject saved) {
        execute(() -> {
            JSONObject body = new JSONObject().put("command_id", saved.getString("command_id"))
                    .put("portion_grams", saved.get("portion_grams")).put("expires_at", saved.getString("expires_at"));
            return api().request("POST", "/feeding-commands", body);
        }, result -> {
            saved.put("feeding_id", result.getString("feeding_id"));
            saved.put("status", result.getString("status"));
            savePending(saved);
            restartPendingMonitor();
            render();
            notice.setText("Команда принята. Ожидаем результат от кормушки.");
        });
    }

    private void schedulePage() {
        LinearLayout panel = card("Расписания");
        label(panel, "Расписание выполняет кормушка, даже когда телефон закрыт.", 14, false);
        button(panel, "Добавить расписание", () -> scheduleForm(null));
        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        panel.addView(list);
        button(panel, "Обновить список", () -> execute(() -> api().request("GET", "/schedules", null), result -> {
            list.removeAllViews();
            JSONArray items = result.getJSONArray("items");
            if (items.length() == 0) label(list, "Пока нет расписаний", 15, false);
            for (int index = 0; index < items.length(); index++) {
                JSONObject schedule = items.getJSONObject(index);
                label(list, schedule.getString("time_local") + " · " + schedule.get("portion_grams") + " г", 20, true);
                label(list, schedule.getJSONArray("days_of_week").join(", ").replace("\"", "")
                        + "\n" + schedule.getString("timezone") + " · "
                        + (schedule.getBoolean("active") ? "Включено" : "Выключено"), 14, false);
                button(list, "Изменить", () -> scheduleForm(schedule));
                button(list, "Удалить", () -> new AlertDialog.Builder(this).setTitle("Удалить расписание?")
                        .setNegativeButton("Отмена", null).setPositiveButton("Удалить", (dialog, which) -> execute(
                                () -> api().request("DELETE", "/schedules/" + schedule.getString("schedule_id"), null),
                                response -> { notice.setText("Расписание удалено. Обновите список."); schedulePageReset(); })).show());
            }
        }));
    }

    private void schedulePageReset() { clearContent(); schedulePage(); }

    private void scheduleForm(JSONObject existing) {
        LinearLayout form = new LinearLayout(this);
        form.setPadding(dp(20), dp(10), dp(20), dp(10));
        form.setOrientation(LinearLayout.VERTICAL);
        EditText time = input(form, "Время HH:mm:ss", existing == null ? "08:30:00" : existing.optString("time_local"), InputType.TYPE_CLASS_DATETIME);
        EditText grams = input(form, "Порция, г", existing == null ? "40" : existing.optString("portion_grams"), InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        EditText zone = input(form, "Часовой пояс", existing == null ? ZoneId.systemDefault().getId() : existing.optString("timezone"), InputType.TYPE_CLASS_TEXT);
        String[] days = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"};
        String[] names = {"Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"};
        CheckBox[] chosen = new CheckBox[7];
        for (int i = 0; i < 7; i++) {
            chosen[i] = new CheckBox(this);
            chosen[i].setText(names[i]);
            chosen[i].setChecked(existing == null || existing.optJSONArray("days_of_week").toString().contains("\"" + days[i] + "\""));
            form.addView(chosen[i]);
        }
        CheckBox active = new CheckBox(this);
        active.setText("Включено");
        active.setChecked(existing == null || existing.optBoolean("active"));
        form.addView(active);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(form);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle(existing == null ? "Новое расписание" : "Изменить расписание")
                .setView(scroll).setNegativeButton("Отмена", null).setPositiveButton("Сохранить", null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                String localTime = time.getText().toString().trim();
                if (!localTime.matches("([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]")) throw new IllegalArgumentException("Время должно быть в формате HH:mm:ss");
                String timezone = zone.getText().toString().trim();
                if (!ZoneId.getAvailableZoneIds().contains(timezone)) throw new IllegalArgumentException("Укажите часовой пояс IANA, например Europe/Moscow");
                JSONArray selected = new JSONArray();
                for (int i = 0; i < 7; i++) if (chosen[i].isChecked()) selected.put(days[i]);
                if (selected.length() == 0) throw new IllegalArgumentException("Выберите хотя бы один день");
                JSONObject body = new JSONObject().put("time_local", localTime).put("days_of_week", selected)
                        .put("timezone", timezone).put("portion_grams", ManualCommand.portion(grams.getText().toString())).put("active", active.isChecked());
                dialog.dismiss();
                execute(() -> api().request(existing == null ? "POST" : "PUT", "/schedules"
                                + (existing == null ? "" : "/" + existing.getString("schedule_id")), body),
                        result -> { notice.setText("Расписание сохранено. Обновите список."); schedulePageReset(); });
            } catch (Exception error) { Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show(); }
        }));
        dialog.show();
    }

    private void historyPage() {
        LinearLayout panel = card("История кормлений");
        button(panel, "Обновить историю", () -> { clearHistory(); loadHistory(); });
        for (int i = 0; i < history.length(); i++) {
            JSONObject item = history.optJSONObject(i);
            label(panel, feedingStatus(item.optString("status")) + " · " + item.optString("portion_grams") + " г", 18, true);
            label(panel, ("manual".equals(item.optString("source")) ? "Вручную" : "По расписанию")
                    + "\nВыдано: " + value(item, "actual_grams") + " г\n" + value(item, "created_at")
                    + (item.isNull("error_code") ? "" : "\nОшибка: " + item.optString("error_code")), 14, false);
        }
        if (history.length() == 0) label(panel, "Нажмите «Обновить историю», чтобы получить данные сервера.", 14, false);
        if (nextCursor != null) button(panel, "Загрузить ещё", this::loadHistory);
    }

    private void loadHistory() {
        String suffix = "/feedings?limit=50" + (nextCursor == null ? "" : "&cursor="
                + android.net.Uri.encode(nextCursor));
        execute(() -> api().request("GET", suffix, null), result -> {
            JSONArray items = result.getJSONArray("items");
            for (int i = 0; i < items.length(); i++) history.put(items.getJSONObject(i));
            nextCursor = result.isNull("next_cursor") ? null : result.getString("next_cursor");
            clearContent(); historyPage();
            notice.setText(history.length() == 0 ? "История пока пуста" : "История обновлена");
        });
    }

    private void clearHistory() { while (history.length() > 0) history.remove(history.length() - 1); nextCursor = null; }
    private void clearContent() { content.removeAllViews(); controls.clear(); controls.addAll(navigationControls); }
    private FeederApi api() { return new FeederApi(connection); }
    private String pendingKey() { return "pending:" + connection.storageKey(); }
    private JSONObject pending() {
        String saved = preferences.getString(pendingKey(), null);
        if (saved == null) return null;
        try { return new JSONObject(saved); }
        catch (Exception error) { showError("Не удалось прочитать сохранённую команду. Новая выдача заблокирована."); return new JSONObject(); }
    }
    private boolean savePending(JSONObject command) {
        boolean saved = preferences.edit().putString(pendingKey(), command.toString()).commit();
        if (!saved) showError("Не удалось сохранить команду на телефоне. Проверьте историю перед новой подачей.");
        return saved;
    }

    private void restartPendingMonitor() {
        if (poller != null) poller.stop();
        poller = null;
        if (!visible || connection == null) return;
        JSONObject command = pending();
        if (command == null || command.optString("feeding_id").isEmpty()
                || command.optString("command_id").isEmpty()) return;
        ConnectionSettings origin = connection;
        String feedingId = command.optString("feeding_id");
        String commandId = command.optString("command_id");
        poller = new FeedingPoller(new FeedingPoller.Scheduler() {
            @Override public void postDelayed(Runnable action, long delay) { pollingHandler.postDelayed(action, delay); }
            @Override public void remove(Runnable action) { pollingHandler.removeCallbacks(action); }
        }, worker, action -> pollingHandler.post(action), () -> FeedingResult.parse(feedingId, commandId,
                new FeederApi(origin).request("GET", "/feedings/" + feedingId, null)), new FeedingPoller.Listener() {
            @Override public void onResult(FeedingResult result) throws Exception {
                if (connection != origin) return;
                acceptFeedingResult(command, result);
            }
            @Override public void onError(Exception error) {
                if (page.equals("Кормушка")) showError("Результат пока недоступен. Повторим проверку автоматически; новая команда не отправляется.");
            }
        }, () -> !busy);
        poller.start();
    }

    private void acceptFeedingResult(JSONObject command, FeedingResult result) throws Exception {
        JSONObject current = pending();
        if (current == null || !command.getString("command_id").equals(current.optString("command_id"))) return;
        // Запоздалый ответ не должен возвращать начавшуюся выдачу в очередь.
        if ("running".equals(current.optString("status")) && "pending".equals(result.status)) return;
        if (result.terminal()) {
            String message = getString(R.string.feeding_result, feedingStatus(result.status),
                    result.actualGrams == null ? "—" : result.actualGrams.toPlainString());
            if (!preferences.edit().remove(pendingKey())
                    .putString("last-result:" + connection.storageKey(), message).commit())
                throw new java.io.IOException("Could not persist result");
            if (poller != null) poller.stop();
            FeedingNotifications.show(this, connection.storageKey(), result);
            if (page.equals("Кормушка")) render();
            notice.setText(message);
        } else if (!result.status.equals(current.optString("status"))) {
            current.put("status", result.status);
            if (!savePending(current)) throw new java.io.IOException("Could not persist command status");
            if (page.equals("Кормушка")) render();
        }
    }

    @Override protected void onStart() { super.onStart(); visible = true; restartPendingMonitor(); }
    @Override protected void onStop() {
        visible = false;
        if (poller != null) poller.stop();
        super.onStop();
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 10 && page.equals("Кормушка")) render();
    }

    private interface Request { JSONObject run() throws Exception; }
    private interface Result { void accept(JSONObject value) throws Exception; }
    private void execute(Request request, Result result) {
        if (busy) return;
        busy = true;
        enableControls(false);
        notice.setText("Загрузка…");
        worker.execute(() -> {
            try {
                JSONObject response = request.run();
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    busy = false;
                    enableControls(true);
                    try { notice.setText("Данные получены"); result.accept(response); }
                    catch (Exception error) { showError("Ответ сервера не соответствует контракту API"); }
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    busy = false;
                    enableControls(true);
                    showError(error instanceof FeederApi.ApiException ? error.getMessage()
                            : "Не удалось получить ответ. Проверьте связь. Для ручной команды используйте повтор того же запроса.");
                    if (page.equals("Кормушка")) render();
                });
            }
        });
    }
    private void enableControls(boolean enabled) { for (View view : controls) view.setEnabled(enabled); }
    private void showError(String message) { notice.setText(message); }

    private LinearLayout card(String title) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(16), dp(16), dp(16), dp(16));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.WHITE); background.setCornerRadius(dp(18));
        box.setBackground(background);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(0, dp(12), 0, dp(4));
        content.addView(box, params);
        label(box, title, 22, true);
        return box;
    }
    private TextView label(LinearLayout parent, String text, int size, boolean bold) {
        TextView label = new TextView(this);
        label.setText(text); label.setTextSize(size); label.setTextColor(Color.rgb(30, 57, 53));
        label.setPadding(0, dp(5), 0, dp(8));
        if (bold) label.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        parent.addView(label, new LinearLayout.LayoutParams(-1, -2));
        return label;
    }
    private EditText input(LinearLayout parent, String hint, String value, int type) {
        label(parent, hint, 13, false);
        EditText field = new EditText(this);
        field.setSingleLine(true); field.setText(value); field.setHint(hint); field.setInputType(type);
        field.setSaveEnabled(false);
        field.setMinHeight(dp(48));
        parent.addView(field, new LinearLayout.LayoutParams(-1, -2));
        controls.add(field);
        return field;
    }
    private Button button(LinearLayout parent, String title, Runnable action) {
        Button button = new Button(this);
        button.setText(title); button.setAllCaps(false); button.setMinHeight(dp(48));
        button.setTextColor(Color.rgb(20, 125, 115));
        button.setOnClickListener(view -> action.run());
        parent.addView(button, new LinearLayout.LayoutParams(-1, -2));
        controls.add(button); button.setEnabled(!busy);
        return button;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private static String value(JSONObject object, String key) { return object.isNull(key) ? "—" : object.optString(key, "—"); }
    private static String feedingStatus(String value) {
        return switch (value) {
            case "pending" -> "Ожидает кормушку"; case "running" -> "Выдаётся корм";
            case "completed" -> "Корм выдан"; case "failed" -> "Ошибка выдачи";
            case "expired" -> "Срок команды истёк"; default -> "Неизвестный статус";
        };
    }
    private static String deviceStatus(String value) {
        return switch (value) {
            case "online" -> "На связи"; case "busy" -> "Кормушка занята";
            case "error" -> "Ошибка устройства"; case "offline" -> "Нет связи с кормушкой";
            default -> "Состояние неизвестно";
        };
    }
    @Override protected void onDestroy() { worker.shutdownNow(); super.onDestroy(); }
}
