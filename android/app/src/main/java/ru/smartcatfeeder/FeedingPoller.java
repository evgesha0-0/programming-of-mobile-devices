package ru.smartcatfeeder;

import java.util.concurrent.Executor;
import java.util.function.BooleanSupplier;

/** Все start/stop и обратные вызовы выполняются на главном потоке. Запросы — на worker. */
public final class FeedingPoller {
    public interface Scheduler {
        void postDelayed(Runnable action, long delayMillis);
        void remove(Runnable action);
    }
    public interface Reader { FeedingResult read() throws Exception; }
    public interface Listener {
        void onResult(FeedingResult result) throws Exception;
        void onError(Exception error);
    }

    private final Scheduler scheduler;
    private final Executor worker;
    private final Executor main;
    private final Reader reader;
    private final Listener listener;
    private final BooleanSupplier canPoll;
    private boolean running;
    private long generation;
    private int failures;
    private Runnable scheduled;

    public FeedingPoller(Scheduler scheduler, Executor worker, Executor main, Reader reader,
                         Listener listener, BooleanSupplier canPoll) {
        this.scheduler = scheduler;
        this.worker = worker;
        this.main = main;
        this.reader = reader;
        this.listener = listener;
        this.canPoll = canPoll;
    }

    public void start() {
        if (running) return;
        running = true;
        failures = 0;
        schedule(0, ++generation);
    }

    public void stop() {
        running = false;
        generation++;
        if (scheduled != null) scheduler.remove(scheduled);
        scheduled = null;
    }

    private boolean current(long expected) { return running && expected == generation; }
    private void schedule(long delay, long expected) {
        if (!current(expected)) return;
        scheduled = () -> poll(expected);
        scheduler.postDelayed(scheduled, delay);
    }

    private void poll(long expected) {
        scheduled = null;
        if (!current(expected)) return;
        if (!canPoll.getAsBoolean()) { schedule(5000, expected); return; }
        worker.execute(() -> {
            try {
                FeedingResult result = reader.read();
                main.execute(() -> {
                    if (!current(expected)) return;
                    try {
                        listener.onResult(result);
                        failures = 0;
                        if (result.terminal()) stop();
                        else schedule(5000, expected);
                    } catch (Exception error) { failed(error, expected); }
                });
            } catch (Exception error) { main.execute(() -> failed(error, expected)); }
        });
    }

    private void failed(Exception error, long expected) {
        if (!current(expected)) return;
        failures = Math.min(failures + 1, 5);
        listener.onError(error);
        schedule(Math.min(60000, 5000L << (failures - 1)), expected);
    }
}
