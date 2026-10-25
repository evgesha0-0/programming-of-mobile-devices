package ru.smartcatfeeder;

import org.junit.Test;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.Executor;
import static org.junit.Assert.*;

public class FeedingPollerTest {
    private static final class Clock implements FeedingPoller.Scheduler {
        final Queue<Runnable> tasks = new ArrayDeque<>();
        final List<Long> delays = new ArrayList<>();
        @Override public void postDelayed(Runnable task, long delay) { tasks.add(task); delays.add(delay); }
        @Override public void remove(Runnable task) { tasks.remove(task); }
        void tick() { tasks.remove().run(); }
    }
    private static final class Deferred implements Executor {
        final Queue<Runnable> tasks = new ArrayDeque<>();
        @Override public void execute(Runnable task) { tasks.add(task); }
        void finish() { tasks.remove().run(); }
    }
    private static final class Events implements FeedingPoller.Listener {
        final List<String> statuses = new ArrayList<>();
        int errors;
        @Override public void onResult(FeedingResult result) { statuses.add(result.status); }
        @Override public void onError(Exception error) { errors++; }
    }
    private static FeedingResult result(String status) throws Exception {
        if ("completed".equals(status)) return FeedingResultTest.parse(FeedingResultTest.body(status)
                .put("actual_grams", 40).put("finished_at", "2026-10-25T12:00:00Z"));
        return FeedingResultTest.parse(FeedingResultTest.body(status));
    }

    @Test public void followsCommandAndStopsAfterTerminalResult() throws Exception {
        Clock clock = new Clock();
        Events events = new Events();
        Queue<FeedingResult> answers = new ArrayDeque<>(List.of(result("pending"), result("running"), result("completed")));
        FeedingPoller poller = new FeedingPoller(clock, Runnable::run, Runnable::run, answers::remove, events, () -> true);
        poller.start(); poller.start();
        assertEquals(1, clock.tasks.size());
        clock.tick(); clock.tick(); clock.tick();
        assertEquals(List.of("pending", "running", "completed"), events.statuses);
        assertTrue(clock.tasks.isEmpty());
        assertEquals(List.of(0L, 5000L, 5000L), clock.delays);
    }

    @Test public void retriesReadFailuresWithBoundedBackoff() {
        Clock clock = new Clock();
        Events events = new Events();
        FeedingPoller poller = new FeedingPoller(clock, Runnable::run, Runnable::run,
                () -> { throw new IOException("offline"); }, events, () -> true);
        poller.start();
        for (int i = 0; i < 7; i++) clock.tick();
        assertEquals(7, events.errors);
        assertEquals(List.of(0L, 5000L, 10000L, 20000L, 40000L, 60000L, 60000L, 60000L), clock.delays);
        assertTrue(events.statuses.isEmpty());
        poller.stop();
        assertTrue(clock.tasks.isEmpty());
    }

    @Test public void stopAndRestartIgnoreOldInflightResponse() {
        Clock clock = new Clock();
        Deferred worker = new Deferred();
        Events events = new Events();
        FeedingPoller poller = new FeedingPoller(clock, worker, Runnable::run, () -> result("pending"), events, () -> true);
        poller.start(); clock.tick();
        poller.stop(); poller.start();
        worker.finish();
        assertTrue(events.statuses.isEmpty());
        assertEquals(1, clock.tasks.size());
        clock.tick(); worker.finish();
        assertEquals(List.of("pending"), events.statuses);
        poller.stop();
    }

    @Test public void busyScreenDefersWithoutStartingNetworkRequest() {
        Clock clock = new Clock();
        Deferred worker = new Deferred();
        FeedingPoller poller = new FeedingPoller(clock, worker, Runnable::run, () -> result("pending"), new Events(), () -> false);
        poller.start(); clock.tick();
        assertTrue(worker.tasks.isEmpty());
        assertEquals(List.of(0L, 5000L), clock.delays);
        poller.stop();
    }

    @Test public void stoppedPollingDoesNotDeliverLateErrors() {
        Clock clock = new Clock();
        Deferred worker = new Deferred();
        Events events = new Events();
        FeedingPoller poller = new FeedingPoller(clock, worker, Runnable::run,
                () -> { throw new IOException("offline"); }, events, () -> true);
        poller.start(); clock.tick(); poller.stop(); worker.finish();
        assertEquals(0, events.errors);
        assertTrue(clock.tasks.isEmpty());
    }

    @Test public void persistenceFailureKeepsTerminalResultAvailableForRetry() {
        Clock clock = new Clock();
        int[] attempts = {0};
        int[] errors = {0};
        FeedingPoller poller = new FeedingPoller(clock, Runnable::run, Runnable::run, () -> result("expired"),
                new FeedingPoller.Listener() {
                    @Override public void onResult(FeedingResult result) throws Exception {
                        if (++attempts[0] == 1) throw new IOException("storage unavailable");
                    }
                    @Override public void onError(Exception error) { errors[0]++; }
                }, () -> true);
        poller.start(); clock.tick();
        assertEquals(1, errors[0]);
        assertEquals(1, clock.tasks.size());
        clock.tick();
        assertEquals(2, attempts[0]);
        assertTrue(clock.tasks.isEmpty());
    }
}
