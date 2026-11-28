import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { HttpBackendGateway } from '../../src/adapters/backend-http/index.js';
import { SqliteLocalStore } from '../../src/adapters/storage-sqlite/index.js';
import { SystemClock } from '../../src/adapters/system-clock/index.js';
import { deviceApiPaths, scheduledFeedingEventRequestSchema } from '../../src/contracts/index.js';
import { deviceIdSchema, feedingIdSchema, scheduleIdSchema } from '../../src/domain/index.js';
import { runRuntime, type BootstrapRuntimeOptions } from '../../src/runtime/index.js';
import { SimulatedMotor } from '../../src/simulator/index.js';

const deviceId = deviceIdSchema.parse('d6d174f4-e79f-49d1-9476-78bc99483752');
const scheduleId = scheduleIdSchema.parse('36ee8225-cd00-46ea-b6ef-db9e66c0946b');
const initialTime = '2026-11-23T08:31:00.000Z';
const scheduledFor = '2026-11-23T08:30:00.000Z';
const occurrenceKey = `${scheduleId}:2026-11-23T08:30:00[UTC]`;
const backendUrl = 'https://backend.example.test';
const expectedPaths = new Set([
  deviceApiPaths.state(deviceId),
  deviceApiPaths.schedules(deviceId, 1),
  deviceApiPaths.pendingCommands(deviceId, 10),
  deviceApiPaths.feedingEvents(deviceId),
].map((path) => new URL(path, backendUrl).pathname));

test('runtime polls commands and retries delivery without stopping scheduled feeding on backend 503', { timeout: 5_000 }, async (t) => {
  const attempted = new Set<string>();
  const harness = runtimeHarness(t, async (input) => {
    attempted.add(new URL(String(input)).pathname);
    return new Response(null, { status: 503 });
  }, (event) => {
    if (event === 'outbox_delivery_retry_scheduled') process.emit('SIGTERM', 'SIGTERM');
  });

  await runWithTestShutdown(t, harness.options);

  assert.deepEqual(attempted, expectedPaths);
  assert.ok(harness.events.includes('command_poll_failed'));
  assert.ok(harness.events.includes('outbox_delivery_retry_scheduled'));
  assert.deepEqual(harness.events.filter((event) => event.endsWith(':close')), ['network:close', 'sqlite:close']);
  const { feeding, message } = readSavedResult(harness.databasePath);
  assert.equal(feeding.status, 'completed');
  assert.equal(message.attemptCount, 1);
  assert.equal(message.deliveredAt, null);
  assert.equal(message.failedAt, null);
});

test('SIGTERM cancels network and waits for motor stop and a durable result before SQLite closes', { timeout: 5_000 }, async (t) => {
  const cancelled = new Set<string>();
  const signalListeners = process.listenerCount('SIGTERM');
  const harness = runtimeHarness(t, (input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    const path = new URL(String(input)).pathname;
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        cancelled.add(path);
        reject(new DOMException('Request aborted', 'AbortError'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }, (event) => {
    if (event === 'telemetry.motor_running') process.emit('SIGTERM', 'SIGTERM');
  });
  const previousFeedingId = feedingIdSchema.parse('b01f6503-fad1-4d5d-b734-864159d9b1e6');
  const backlogId = harness.store.enqueueOutbox({
    kind: 'scheduled_event',
    aggregateId: previousFeedingId,
    payload: JSON.stringify({
      feeding_id: previousFeedingId, schedule_id: scheduleId, source: 'scheduled',
      portion_grams: 10, actual_grams: 10, status: 'completed',
      created_at: scheduledFor, started_at: scheduledFor, finished_at: scheduledFor,
      error_code: null, error_message: null,
    }),
    createdAt: scheduledFor,
    nextAttemptAt: scheduledFor,
  });

  let notifyStop!: (motor: SimulatedMotor) => void;
  let allowStop!: () => void;
  const stopEntered = new Promise<SimulatedMotor>((resolve) => { notifyStop = resolve; });
  const stopAllowed = new Promise<void>((resolve) => { allowStop = resolve; });
  const stop = SimulatedMotor.prototype.stop;
  t.mock.method(SimulatedMotor.prototype, 'stop', async function (this: SimulatedMotor, signal: AbortSignal) {
    notifyStop(this);
    await stopAllowed;
    await stop.call(this, signal);
  });
  t.signal.addEventListener('abort', allowStop, { once: true });

  const running = runWithTestShutdown(t, harness.options);
  let motor: SimulatedMotor;
  try {
    motor = await Promise.race([
      stopEntered,
      running.then(() => assert.fail('Runtime closed before stopping the active motor')),
    ]);
    const claim = harness.store.getScheduleOccurrence(occurrenceKey);
    assert.ok(claim);
    assert.equal(harness.store.getFeeding(claim.feedingId)?.status, 'running');
    assert.equal(motor.getState(), 'running');
    assert.equal(harness.events.includes('sqlite:close'), false);
    assert.equal(process.listenerCount('SIGTERM'), signalListeners + 1);
    process.emit('SIGTERM', 'SIGTERM');
  } finally {
    allowStop();
    await running;
    t.signal.removeEventListener('abort', allowStop);
  }

  assert.deepEqual(cancelled, expectedPaths);
  assert.equal(motor.getState(), 'stopped');
  assert.deepEqual(harness.events.filter((event) => event === 'telemetry.motor_stopped' || event.endsWith(':close')), [
    'network:close', 'telemetry.motor_stopped', 'sqlite:close',
  ]);
  assert.equal(process.listenerCount('SIGTERM'), signalListeners);
  const { feeding, backlog } = readSavedResult(harness.databasePath, backlogId);
  assert.equal(feeding.status, 'failed');
  assert.equal(backlog?.attemptCount, 0);
  assert.equal(backlog?.deliveredAt, null);
});

function runtimeHarness(t: TestContext, fetchImplementation: typeof fetch, onLog: (event: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'smart-cat-feeder-runtime-'));
  const databasePath = join(directory, 'device.sqlite');
  const store = SqliteLocalStore.open({ databasePath });
  const closeStore = store.close.bind(store);
  t.after(() => {
    closeStore();
    rmSync(directory, { recursive: true, force: true });
  });
  store.replaceScheduleSnapshot({
    revision: 1,
    generatedAt: initialTime,
    items: [{
      scheduleId, timeLocal: '08:30:00', daysOfWeek: ['mon'], timezone: 'UTC',
      portionGrams: 10, active: true, updatedAt: scheduledFor, deletedAt: null,
    }],
  });
  const events: string[] = [];
  t.mock.method(store, 'close', () => {
    events.push('sqlite:close');
    closeStore();
  });
  t.mock.method(SystemClock.prototype, 'now', () => new Date(initialTime));
  const options: BootstrapRuntimeOptions = {
    environment: {
      NODE_ENV: 'test', LOG_LEVEL: 'info', BACKEND_URL: backendUrl, DEVICE_ID: deviceId,
      DEVICE_TOKEN: `dvc_${'A'.repeat(43)}`, SQLITE_PATH: databasePath, SCHEDULER_TICK_MS: '100',
      SIMULATOR_SOCKET_PATH: process.platform === 'win32' ? `\\\\.\\pipe\\${basename(directory)}` : join(directory, 'ctl.sock'),
    },
    now: () => new Date(initialTime),
    logSink(line) {
      const { event } = JSON.parse(line) as { event: string };
      events.push(event);
      onLog(event);
    },
    dependencies: {
      openStore: () => store,
      openNetwork(config, logger) {
        const gateway = new HttpBackendGateway({ ...config, logger, fetchImplementation, maxAttempts: 1 });
        const closeGateway = gateway.close.bind(gateway);
        t.mock.method(gateway, 'close', () => {
          events.push('network:close');
          closeGateway();
        });
        return gateway;
      },
    },
  };
  return { databasePath, store, events, options };
}

function runWithTestShutdown(t: TestContext, options: BootstrapRuntimeOptions): Promise<void> {
  const stop = () => { process.emit('SIGTERM', 'SIGTERM'); };
  t.signal.addEventListener('abort', stop, { once: true });
  return runRuntime(options).finally(() => t.signal.removeEventListener('abort', stop));
}

function readSavedResult(databasePath: string, backlogId?: number) {
  const reopened = SqliteLocalStore.open({ databasePath });
  try {
    const claim = reopened.getScheduleOccurrence(occurrenceKey);
    assert.ok(claim);
    const feeding = reopened.getFeeding(claim.feedingId);
    assert.ok(feeding);
    const message = reopened.listPendingOutbox(10, '2099-01-01T00:00:00.000Z', ['scheduled_event'])
      .find(({ aggregateId }) => aggregateId === feeding.feedingId);
    assert.ok(message);
    assert.equal(message.payload, feeding.terminalPayload);
    assert.equal(scheduledFeedingEventRequestSchema.parse(JSON.parse(message.payload)).status, feeding.status);
    return { feeding, message, backlog: backlogId === undefined ? null : reopened.getOutboxMessage(backlogId) };
  } finally {
    reopened.close();
  }
}
