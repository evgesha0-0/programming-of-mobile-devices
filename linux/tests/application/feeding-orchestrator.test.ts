import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  FeedingOrchestrator,
  DeviceStateReporter,
} from '../../src/application/index.js';
import { SqliteLocalStore } from '../../src/adapters/storage-sqlite/index.js';
import {
  manualFeedingResultRequestSchema,
  scheduledFeedingEventRequestSchema,
} from '../../src/contracts/index.js';
import {
  commandIdSchema,
  deviceIdSchema,
  scheduleIdSchema,
  utcDateTimeSchema,
} from '../../src/domain/index.js';
import { createJsonLogger, LoggerTelemetry } from '../../src/observability/index.js';
import {
  OutboxConflictError,
  type BackendGateway,
  type FeedingIntent,
} from '../../src/ports/index.js';
import {
  createDigitalTwin,
  type SimulatorScenarioName,
} from '../../src/simulator/index.js';

const initialTime = '2026-11-21T13:00:00.000Z';
const deviceId = deviceIdSchema.parse('d6d174f4-e79f-49d1-9476-78bc99483752');
const scheduleId = scheduleIdSchema.parse('811f98b6-e0f9-40ad-9b5e-46d501f1a1d3');
const commandId = commandIdSchema.parse('a891f5dd-645c-4a98-b3b4-a8c3fd6f9dd7');

test('scheduled feeding persists intent before GPIO and commits terminal outbox atomically', async (t) => {
  const harness = createHarness(t, 'normal', 'scheduled-success');
  const intent = scheduledIntent(harness, 20);
  const execution = harness.orchestrator.execute(intent, new AbortController().signal);
  await Promise.resolve();

  assert.equal(harness.store.getFeeding(intent.feedingId)?.status, 'running');
  assert.equal(harness.twin.gpio.transitions().length, 0);
  const result = await driveUntilSettled(harness, execution);

  assert.equal(result.status, 'completed');
  assert.ok((result.actualGrams ?? 0) >= 20);
  assert.equal(harness.twin.motor.getState(), 'stopped');
  assert.equal(harness.twin.gpio.read('motor_enable'), false);
  assert.equal(harness.reporter.getState().status, 'online');
  const stored = harness.store.getFeeding(intent.feedingId);
  assert.equal(stored?.status, 'completed');
  assert.equal(stored?.terminalPayload, result.terminalPayload);
  const outbox = harness.store.listPendingOutbox(
    10,
    utcDateTimeSchema.parse('2099-01-01T00:00:00.000Z'),
  );
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]?.kind, 'scheduled_event');
  assert.equal(outbox[0]?.payload, result.terminalPayload);
  assert.equal(
    scheduledFeedingEventRequestSchema.safeParse(JSON.parse(result.terminalPayload)).success,
    true,
  );
});

test('manual and scheduled executions use the same deterministic physical pipeline', async (t) => {
  const first = createHarness(t, 'normal', 'same-seed');
  const second = createHarness(t, 'normal', 'same-seed');
  const scheduled = await driveUntilSettled(
    first,
    first.orchestrator.execute(scheduledIntent(first, 15), new AbortController().signal),
  );
  const manual = await driveUntilSettled(
    second,
    second.orchestrator.execute(manualIntent(second, 15), new AbortController().signal),
  );

  assert.equal(scheduled.actualGrams, manual.actualGrams);
  assert.equal(manual.status, 'completed');
  assert.equal(
    manualFeedingResultRequestSchema.safeParse(JSON.parse(manual.terminalPayload)).success,
    true,
  );
  assert.equal(
    second.store.listPendingOutbox(
      10,
      utcDateTimeSchema.parse('2099-01-01T00:00:00.000Z'),
    )[0]?.kind,
    'manual_result',
  );
});

test('motor jam produces MOTOR_ERROR and always performs safe stop', async (t) => {
  const harness = createHarness(t, 'motor-jam', 'jam-feeding');
  const intent = scheduledIntent(harness, 20);
  const result = await driveUntilSettled(
    harness,
    harness.orchestrator.execute(intent, new AbortController().signal),
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'MOTOR_ERROR');
  assert.equal(harness.reporter.getState().status, 'error');
  assert.equal(harness.reporter.getState().errorCode, 'MOTOR_ERROR');
  assert.equal(harness.twin.motor.getState(), 'stopped');
  assert.equal(harness.twin.gpio.read('motor_enable'), false);
  assert.equal(harness.store.getFeeding(intent.feedingId)?.status, 'failed');
});

test('sensor disconnect and timeout produce WEIGHT_SENSOR_ERROR', async (t) => {
  for (const scenario of ['sensor-disconnect', 'sensor-timeout'] as const) {
    const harness = createHarness(t, scenario, `sensor-${scenario}`);
    const intent = scheduledIntent(harness, 20);
    const result = await driveUntilSettled(
      harness,
      harness.orchestrator.execute(intent, new AbortController().signal),
      10_000,
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'WEIGHT_SENSOR_ERROR');
    assert.equal(result.actualGrams, null);
    assert.equal(harness.twin.motor.getState(), 'stopped');
    assert.equal(harness.store.getFeeding(intent.feedingId)?.status, 'failed');
  }
});

test('execution timeout produces MOTOR_ERROR and emergency-safe terminal state', async (t) => {
  const harness = createHarness(t, 'underfeed', 'timeout-feeding', 500);
  const result = await driveUntilSettled(
    harness,
    harness.orchestrator.execute(scheduledIntent(harness, 100), new AbortController().signal),
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'MOTOR_ERROR');
  assert.equal(harness.twin.motor.getState(), 'stopped');
  assert.ok((result.actualGrams ?? 0) > 0);
});

test('execution lock prevents simultaneous physical feeding', async (t) => {
  const harness = createHarness(t, 'normal', 'parallel-feedings');
  const firstIntent = scheduledIntent(harness, 8);
  const secondIntent = scheduledIntent(harness, 8);
  const first = harness.orchestrator.execute(firstIntent, new AbortController().signal);
  const second = harness.orchestrator.execute(secondIntent, new AbortController().signal);

  const results = await driveUntilSettled(harness, Promise.all([first, second]), 10_000);

  assert.deepEqual(results.map((result) => result.status), ['completed', 'completed']);
  assert.equal(harness.store.getFeeding(firstIntent.feedingId)?.status, 'completed');
  assert.equal(harness.store.getFeeding(secondIntent.feedingId)?.status, 'completed');
  assert.equal(harness.twin.executionLock.isLocked(), false);
});

test('outbox conflict rolls terminal update back to running', async (t) => {
  const harness = createHarness(t, 'normal', 'atomic-outbox');
  const intent = scheduledIntent(harness, 10);
  harness.store.enqueueOutbox({
    kind: 'scheduled_event',
    aggregateId: intent.feedingId,
    payload: '{"conflicting":true}',
    createdAt: intent.createdAt,
    nextAttemptAt: intent.createdAt,
  });

  await assert.rejects(
    driveUntilSettled(
      harness,
      harness.orchestrator.execute(intent, new AbortController().signal),
    ),
    OutboxConflictError,
  );

  const stored = harness.store.getFeeding(intent.feedingId);
  assert.equal(stored?.status, 'running');
  assert.equal(stored?.terminalPayload, null);
  assert.equal(harness.twin.motor.getState(), 'stopped');
  assert.equal(harness.reporter.getState().errorCode, 'INTERNAL_ERROR');
});

interface Harness {
  readonly store: SqliteLocalStore;
  readonly twin: ReturnType<typeof createDigitalTwin>;
  readonly reporter: DeviceStateReporter;
  readonly orchestrator: FeedingOrchestrator;
}

function createHarness(
  t: TestContext,
  scenario: SimulatorScenarioName,
  seed: string,
  maximumExecutionMs = 5_000,
): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'smart-cat-feeder-orchestrator-'));
  const store = SqliteLocalStore.open({ databasePath: join(directory, 'device.sqlite') });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const logger = createJsonLogger({ level: 'error', sink: () => {} });
  const telemetry = new LoggerTelemetry(logger);
  const twin = createDigitalTwin({ seed, initialTime, scenario, telemetry });
  const reporter = new DeviceStateReporter({
    deviceId,
    firmwareVersion: '0.1.0',
    heartbeatIntervalMs: 30_000,
    maxClockSkewMs: 30_000,
    gateway: { close() {} } as BackendGateway,
    store,
    clock: twin.clock,
    logger,
  });
  return {
    store,
    twin,
    reporter,
    orchestrator: new FeedingOrchestrator({
      store,
      executionLock: twin.executionLock,
      motor: twin.motor,
      weightSensor: twin.weightSensor,
      clock: twin.clock,
      deviceStateReporter: reporter,
      telemetry,
      maximumExecutionMs,
    }),
  };
}

function scheduledIntent(harness: Harness, portionGrams: number): FeedingIntent {
  return {
    feedingId: harness.twin.idGenerator.generateFeedingId(),
    source: 'scheduled',
    commandId: null,
    scheduleId,
    portionGrams,
    createdAt: utcDateTimeSchema.parse(harness.twin.clock.now().toISOString()),
  };
}

function manualIntent(harness: Harness, portionGrams: number): FeedingIntent {
  return {
    feedingId: harness.twin.idGenerator.generateFeedingId(),
    source: 'manual',
    commandId,
    scheduleId: null,
    portionGrams,
    createdAt: utcDateTimeSchema.parse(harness.twin.clock.now().toISOString()),
  };
}

async function driveUntilSettled<T>(
  harness: Harness,
  operation: Promise<T>,
  maximumVirtualMs = 8_000,
): Promise<T> {
  let settled = false;
  operation.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  for (let elapsed = 0; !settled && elapsed < maximumVirtualMs; elapsed += 25) {
    await harness.twin.clock.advanceBy(25);
  }
  if (!settled) throw new Error('Feeding did not settle within virtual time limit');
  return operation;
}
