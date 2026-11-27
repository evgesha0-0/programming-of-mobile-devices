import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import {
  CommandPoller,
  DeviceStateReporter,
  FeedingOrchestrator,
  ManualCommandQueue,
  ManualFeedingWorker,
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
import { createJsonLogger, LoggerTelemetry, type JsonLogger } from '../../src/observability/index.js';
import {
  BackendConflictError,
  BackendTransportError,
  OutboxConflictError,
  type BackendGateway,
  type ManualCommand,
  type ScheduledFeedingIntent,
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
  second.store.recordManualCommand(manualCommand(second, 15));
  deliverHeartbeat(second);
  const manual = await driveUntilSettled(
    second,
    second.orchestrator.executeNextManual(commandQueue(second), new AbortController().signal),
  );

  assert.ok(manual);
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

test('manual feeding does not touch the motor after a refused or lost ack', async (t) => {
  for (const failure of [
    new BackendConflictError('req-refused', 'CONFLICT'),
    new BackendTransportError(1, new Error('offline')),
  ]) {
    const harness = createHarness(t, 'normal', failure.name);
    const command = manualCommand(harness, 8);
    harness.store.recordManualCommand(command);
    deliverHeartbeat(harness);
    const queue = commandQueue(harness, async () => {
      assert.equal(harness.twin.executionLock.isLocked(), true);
      throw failure;
    });

    assert.equal(await manualWorker(harness, queue).tick(new AbortController().signal), null);
    assert.equal(harness.twin.executionLock.isLocked(), false);
    assert.equal(harness.twin.gpio.transitions().length, 0);
    assert.equal(harness.store.getFeeding(command.feedingId), null);
  }
});

test('the shared lease spans manual ack through actuation and excludes scheduled feeding', async (t) => {
  const harness = createHarness(t, 'normal', 'shared-lease');
  const command = manualCommand(harness, 8);
  const scheduled = scheduledIntent(harness, 8);
  harness.store.recordManualCommand(command);
  deliverHeartbeat(harness);
  const signal = new AbortController().signal;
  let notifyAck!: () => void;
  let releaseAck!: () => void;
  const ackRequested = new Promise<void>((resolve) => { notifyAck = resolve; });
  const ackReply = new Promise<void>((resolve) => { releaseAck = resolve; });
  let ackStartedAt = '';
  const queue = commandQueue(harness, async (id, request) => {
    ackStartedAt = request.started_at;
    notifyAck();
    await ackReply;
    return acceptAck(id, request);
  });

  const startMotor = harness.twin.motor.start.bind(harness.twin.motor);
  let starts = 0;
  t.mock.method(harness.twin.motor, 'start', (motorSignal: AbortSignal) => {
    if (starts++ === 0) {
      const reader = new DatabaseSync(harness.databasePath, { readOnly: true });
      try {
        const row = reader.prepare(`
          SELECT commands.phase, feedings.status, feedings.started_at FROM commands
          JOIN feedings USING (feeding_id) WHERE commands.command_id = ?
        `).get(command.commandId);
        assert.equal(row?.phase, 'actuation_intent');
        assert.equal(row?.status, 'running');
        assert.equal(row?.started_at, ackStartedAt);
      } finally {
        reader.close();
      }
      assert.equal(harness.store.getFeeding(scheduled.feedingId), null);
    } else {
      assert.equal(harness.store.getFeeding(command.feedingId)?.status, 'completed');
      assert.equal(harness.twin.motor.getState(), 'stopped');
    }
    return startMotor(motorSignal);
  });

  const manualRun = harness.orchestrator.executeNextManual(queue, signal);
  const scheduledRun = harness.orchestrator.execute(scheduled, signal);
  await ackRequested;
  await harness.twin.clock.advanceBy(250);
  assert.equal(harness.twin.executionLock.isLocked(), true);
  assert.equal(harness.twin.gpio.transitions().length, 0);
  assert.equal(harness.store.getFeeding(scheduled.feedingId), null);
  releaseAck();

  const [manualResult, scheduledResult] = await driveUntilSettled(
    harness, Promise.all([manualRun, scheduledRun]), 10_000,
  );
  assert.equal(manualResult?.status, 'completed');
  assert.equal(manualResult.startedAt, ackStartedAt);
  assert.equal(scheduledResult.status, 'completed');
  assert.equal(starts, 2);
  assert.equal(harness.twin.executionLock.isLocked(), false);
});

test('repeated pending delivery never dispenses again and the result uses the ack identity', async (t) => {
  const harness = createHarness(t, 'normal', 'duplicate-pending');
  const command = manualCommand(harness, 8);
  deliverHeartbeat(harness, 1_500);
  await pollManualCommand(harness, command);
  const signal = new AbortController().signal;
  let ackCount = 0;
  let resultCount = 0;
  let ackStartedAt = '';
  const queue = commandQueue(harness, (id, request) => {
    ackCount += 1;
    assert.equal(id, command.commandId);
    assert.equal(request.feeding_id, command.feedingId);
    ackStartedAt = request.started_at;
    return acceptAck(id, request);
  });
  const worker = manualWorker(harness, queue, async (feedingId, payload) => {
    resultCount += 1;
    assert.equal(feedingId, command.feedingId);
    assert.equal(payload.command_id, command.commandId);
    assert.equal(payload.started_at, ackStartedAt);
    assert.equal(payload.status, 'completed');
    const [queued] = harness.store.listPendingOutbox(10, '2099-01-01T00:00:00.000Z');
    assert.equal(queued?.aggregateId, feedingId);
    assert.deepEqual(JSON.parse(queued.payload), payload);
    return {
      requestId: null,
      data: {
        feeding_id: feedingId,
        command_id: payload.command_id,
        status: payload.status,
        actual_grams: payload.actual_grams,
        finished_at: payload.finished_at,
      },
    };
  });

  assert.equal((await driveUntilSettled(harness, worker.tick(signal)))?.status, 'completed');
  const transitions = harness.twin.gpio.transitions();
  assert.equal(transitions.filter(({ line, value }) => line === 'motor_enable' && value).length, 1);
  await pollManualCommand(harness, command);
  assert.equal(await worker.tick(signal), null);
  assert.deepEqual(harness.twin.gpio.transitions(), transitions);
  assert.equal(ackCount, 1);
  assert.equal(resultCount, 1);
  assert.deepEqual(harness.store.listPendingOutbox(10, '2099-01-01T00:00:00.000Z'), []);
});

test('a recovered ack can be reconciled after expiry without starting an actuation attempt', async (t) => {
  const harness = createHarness(t, 'normal', 'expired-ack-replay');
  const command = { ...manualCommand(harness, 8), expiresAt: '2026-11-21T13:00:01.000Z' };
  harness.store.recordManualCommand(command);
  deliverHeartbeat(harness);
  assert.ok(harness.store.recordManualAckIntent(command.commandId, initialTime));
  await harness.twin.clock.advanceBy(1_000);
  let replays = 0;
  const queue = commandQueue(harness, (id, request) => {
    replays += 1;
    assert.equal(id, command.commandId);
    assert.equal(request.started_at, initialTime);
    return acceptAck(id, request);
  });

  assert.equal(await harness.orchestrator.executeNextManual(queue, new AbortController().signal), null);
  assert.equal(replays, 1);
  assert.equal(harness.store.getNextPendingManualAck(), null);
  assert.equal(harness.store.getFeeding(command.feedingId), null);
  assert.equal(harness.twin.gpio.transitions().length, 0);
});

test('a saved actuation attempt is not eligible again after reopening the journal', (t) => {
  const harness = createHarness(t, 'normal', 'restart-attempt');
  const command = manualCommand(harness, 8);
  harness.store.recordManualCommand(command);
  const ack = harness.store.recordManualAckIntent(command.commandId, initialTime);
  assert.ok(ack);
  harness.store.resolveManualAck(ack, 'acked');
  assert.ok(harness.store.recordManualActuationIntent(command.commandId, initialTime));
  harness.store.close();

  const reopened = SqliteLocalStore.open({ databasePath: harness.databasePath });
  try {
    assert.equal(reopened.recordManualCommand(command), false);
    assert.equal(reopened.getFeeding(command.feedingId)?.status, 'running');
    assert.equal(reopened.getNextManualCommandWork(initialTime), null);
    assert.equal(reopened.recordManualActuationIntent(command.commandId, initialTime), null);
  } finally {
    reopened.close();
  }
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
  readonly databasePath: string;
  readonly store: SqliteLocalStore;
  readonly twin: ReturnType<typeof createDigitalTwin>;
  readonly reporter: DeviceStateReporter;
  readonly orchestrator: FeedingOrchestrator;
  readonly logger: JsonLogger;
}

function createHarness(
  t: TestContext,
  scenario: SimulatorScenarioName,
  seed: string,
  maximumExecutionMs = 5_000,
): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'smart-cat-feeder-orchestrator-'));
  const databasePath = join(directory, 'device.sqlite');
  const store = SqliteLocalStore.open({ databasePath });
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
    databasePath,
    store,
    twin,
    reporter,
    logger,
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

function scheduledIntent(harness: Harness, portionGrams: number): ScheduledFeedingIntent {
  return {
    feedingId: harness.twin.idGenerator.generateFeedingId(),
    source: 'scheduled',
    commandId: null,
    scheduleId,
    portionGrams,
    createdAt: utcDateTimeSchema.parse(harness.twin.clock.now().toISOString()),
  };
}

function manualCommand(harness: Harness, portionGrams: number): ManualCommand {
  const now = harness.twin.clock.now();
  return {
    feedingId: harness.twin.idGenerator.generateFeedingId(),
    commandId,
    portionGrams,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  };
}

const acceptAck: BackendGateway['acknowledgeCommand'] = async (id, request) => ({
  requestId: null,
  data: { command_id: id, ...request },
});

function commandQueue(
  harness: Harness,
  acknowledgeCommand: BackendGateway['acknowledgeCommand'] = acceptAck,
): ManualCommandQueue {
  return new ManualCommandQueue({
    store: harness.store,
    gateway: { acknowledgeCommand },
    clock: harness.twin.clock,
    maxClockSkewMs: 30_000,
  });
}

function manualWorker(
  harness: Harness,
  queue: ManualCommandQueue,
  reportManualFeedingResult: BackendGateway['reportManualFeedingResult'] = async () => assert.fail('Unexpected result'),
): ManualFeedingWorker {
  return new ManualFeedingWorker({
    queue,
    feedingOrchestrator: harness.orchestrator,
    store: harness.store,
    gateway: { reportManualFeedingResult },
    clock: harness.twin.clock,
    logger: harness.logger,
    intervalMs: 5_000,
  });
}

function deliverHeartbeat(harness: Harness, clockOffsetMs = 0): void {
  const now = harness.twin.clock.now();
  const reportedAt = now.toISOString();
  harness.store.savePendingHeartbeat({
    status: 'online',
    reported_at: reportedAt,
    firmware_version: '0.1.0',
    error_code: null,
    error_message: null,
  });
  assert.equal(harness.store.markHeartbeatDelivered({
    reportedAt,
    serverTime: new Date(now.getTime() + clockOffsetMs).toISOString(),
    clockOffsetMs,
    requestId: null,
  }), true);
}

async function pollManualCommand(harness: Harness, command: ManualCommand): Promise<void> {
  const controller = new AbortController();
  const poller = new CommandPoller({
    deviceId,
    pollIntervalMs: 5_000,
    store: harness.store,
    clock: { async sleep() { controller.abort(); } },
    logger: harness.logger,
    gateway: {
      async getPendingCommands() {
        return { requestId: null, data: {
          server_time: harness.twin.clock.now().toISOString(),
          items: [{
            command_id: command.commandId,
            feeding_id: command.feedingId,
            device_id: deviceId,
            status: 'pending',
            portion_grams: command.portionGrams,
            created_at: command.createdAt,
            expires_at: command.expiresAt,
          }],
        } };
      },
    },
  });
  await poller.run(controller.signal);
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
