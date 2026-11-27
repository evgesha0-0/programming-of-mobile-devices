import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  DeviceStateReporter,
  FeedingOrchestrator,
  LocalScheduler,
  SchedulerSingleFlightError,
  resolveDueOccurrences,
} from '../../src/application/index.js';
import { SqliteLocalStore } from '../../src/adapters/storage-sqlite/index.js';
import {
  daysOfWeekSchema,
  deviceIdSchema,
  scheduleIdSchema,
  utcDateTimeSchema,
} from '../../src/domain/index.js';
import type { ScheduledFeedingEventRequest } from '../../src/contracts/index.js';
import { createJsonLogger, LoggerTelemetry } from '../../src/observability/index.js';
import type {
  BackendGateway,
  LocalSchedule,
  LocalScheduleSnapshot,
} from '../../src/ports/index.js';
import { BackendTransportError } from '../../src/ports/index.js';
import { createDigitalTwin } from '../../src/simulator/index.js';

const deviceId = deviceIdSchema.parse('d6d174f4-e79f-49d1-9476-78bc99483752');
const firstScheduleId = scheduleIdSchema.parse('36ee8225-cd00-46ea-b6ef-db9e66c0946b');
const secondScheduleId = scheduleIdSchema.parse('811f98b6-e0f9-40ad-9b5e-46d501f1a1d3');

test('occurrence resolver supports IANA timezone and days_of_week', () => {
  const occurrences = resolveDueOccurrences(
    schedule({
      scheduleId: firstScheduleId,
      timezone: 'UTC',
      timeLocal: '08:30:00',
      daysOfWeek: ['mon'],
    }),
    new Date('2026-11-23T08:31:00.000Z'),
    120_000,
  );

  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0]?.scheduledFor, '2026-11-23T08:30:00.000Z');
  assert.equal(
    occurrences[0]?.occurrenceKey,
    `${firstScheduleId}:2026-11-23T08:30:00[UTC]`,
  );
  assert.equal(resolveDueOccurrences(
    schedule({ daysOfWeek: daysOfWeekSchema.parse(['tue']) }),
    new Date('2026-11-23T08:31:00.000Z'),
    120_000,
  ).length, 0);
});

test('DST gap is skipped and DST fold resolves to the earlier instant once', () => {
  const gap = resolveDueOccurrences(
    schedule({
      timezone: 'America/New_York',
      timeLocal: '02:30:00',
      daysOfWeek: daysOfWeekSchema.parse(['sun']),
    }),
    new Date('2026-03-08T07:05:00.000Z'),
    7_200_000,
  );
  assert.deepEqual(gap, []);

  const fold = resolveDueOccurrences(
    schedule({
      timezone: 'America/New_York',
      timeLocal: '01:30:00',
      daysOfWeek: daysOfWeekSchema.parse(['sun']),
    }),
    new Date('2026-11-01T06:45:00.000Z'),
    7_200_000,
  );
  assert.equal(fold.length, 1);
  assert.equal(fold[0]?.scheduledFor, '2026-11-01T05:30:00.000Z');
  assert.equal(
    fold[0]?.occurrenceKey,
    `${firstScheduleId}:2026-11-01T01:30:00[America/New_York]`,
  );
});

test('inactive, deleted and excessively late schedules are not due', () => {
  const now = new Date('2026-11-23T08:40:00.000Z');
  assert.equal(resolveDueOccurrences(schedule({ active: false }), now, 900_000).length, 0);
  assert.equal(resolveDueOccurrences(schedule({
    active: false,
    deletedAt: '2026-11-23T08:35:00.000Z',
  }), now, 900_000).length, 0);
  assert.equal(resolveDueOccurrences(schedule(), now, 300_000).length, 0);
});

test('scheduler claims feeding_id before execution and emits one history event', async (t) => {
  const harness = schedulerHarness(t, {
    now: '2026-11-23T08:31:00.000Z',
    schedules: [schedule({ portionGrams: 10 })],
    maximumLatenessMs: 300_000,
  });
  const tick = harness.scheduler.tick(new AbortController().signal);
  await Promise.resolve();

  const occurrenceKey = `${firstScheduleId}:2026-11-23T08:30:00[UTC]`;
  const claimed = harness.store.getScheduleOccurrence(occurrenceKey);
  if (!claimed) assert.fail('Occurrence must be claimed before feeding execution');

  const result = await tick;
  assert.equal(result.claimedOccurrences, 1);
  assert.equal(result.executedFeedings, 1);
  const feeding = harness.store.getFeeding(claimed.feedingId);
  assert.equal(feeding?.status, 'completed');
  assert.ok((feeding?.actualGrams ?? 0) >= 10);

  assert.equal(harness.delivery.sawPendingOutbox, true);
  assert.equal(harness.delivery.events.length, 1);
  const event = harness.delivery.events[0] as unknown as Record<string, unknown>;
  assert.equal(event.source, 'scheduled');
  assert.equal(event.schedule_id, firstScheduleId);
  assert.equal(event.feeding_id, claimed.feedingId);
  assert.equal(event.created_at, '2026-11-23T08:30:00.000Z');
  assert.ok(typeof event.actual_grams === 'number');

  const secondTick = await harness.scheduler.tick(new AbortController().signal);
  assert.equal(secondTick.duplicateOccurrences, 1);
  assert.equal(secondTick.executedFeedings, 0);
  assert.equal(harness.delivery.events.length, 1);
  assert.equal(harness.store.listPendingOutbox(
    10,
    utcDateTimeSchema.parse('2099-01-01T00:00:00.000Z'),
  ).length, 0);
});

test('scheduler is single-flight and skips another occurrence after max lateness', async (t) => {
  const harness = schedulerHarness(t, {
    now: '2026-11-23T08:30:01.000Z',
    schedules: [
      schedule({ scheduleId: firstScheduleId, portionGrams: 20 }),
      schedule({ scheduleId: secondScheduleId, portionGrams: 20 }),
    ],
    maximumLatenessMs: 2_000,
  });

  const firstTick = harness.scheduler.tick(new AbortController().signal);
  await assert.rejects(
    harness.scheduler.tick(new AbortController().signal),
    SchedulerSingleFlightError,
  );
  const result = await firstTick;

  assert.equal(result.dueOccurrences, 2);
  assert.equal(result.executedFeedings, 1);
  assert.equal(result.skippedLateOccurrences, 1);
  assert.equal(result.deliveredEvents, 1);
  assert.equal(harness.store.listPendingOutbox(
    10,
    utcDateTimeSchema.parse('2099-01-01T00:00:00.000Z'),
  ).length, 0);
});

test('retryable scheduled event delivery keeps exact payload in outbox', async (t) => {
  const harness = schedulerHarness(t, {
    now: '2026-11-23T08:31:00.000Z',
    schedules: [schedule({ portionGrams: 10 })],
    maximumLatenessMs: 300_000,
    deliveryFailure: new BackendTransportError(3, new Error('offline')),
  });

  const result = await harness.scheduler.tick(new AbortController().signal);

  assert.equal(result.executedFeedings, 1);
  assert.equal(result.deliveredEvents, 0);
  assert.equal(result.queuedEvents, 1);
  const outbox = harness.store.listPendingOutbox(
    10,
    utcDateTimeSchema.parse('2099-01-01T00:00:00.000Z'),
  );
  assert.equal(outbox.length, 1);
  assert.deepEqual(JSON.parse(outbox[0]?.payload ?? '{}'), harness.delivery.events[0]);
});

test('scheduler stops cleanly while waiting for the manual feeding lease', async (t) => {
  const harness = schedulerHarness(t, {
    now: '2026-11-23T08:31:00.000Z',
    schedules: [schedule()],
    maximumLatenessMs: 300_000,
  });
  const controller = new AbortController();
  const manualLease = await harness.executionLock.acquire('manual-ack', controller.signal);
  try {
    const running = harness.scheduler.run(controller.signal);
    const claimed = harness.store.getScheduleOccurrence(`${firstScheduleId}:2026-11-23T08:30:00[UTC]`);
    assert.ok(claimed);
    controller.abort();
    await running;
    assert.equal(harness.store.getFeeding(claimed.feedingId), null);
    assert.equal(harness.delivery.events.length, 0);
  } finally {
    controller.abort();
    manualLease.release();
  }
});

interface SchedulerHarness {
  readonly store: SqliteLocalStore;
  readonly scheduler: LocalScheduler;
  readonly executionLock: ReturnType<typeof createDigitalTwin>['executionLock'];
  readonly delivery: {
    events: ScheduledFeedingEventRequest[];
    sawPendingOutbox: boolean;
  };
}

function schedulerHarness(
  t: TestContext,
  options: {
    now: string;
    schedules: readonly LocalSchedule[];
    maximumLatenessMs: number;
    deliveryFailure?: Error;
  },
): SchedulerHarness {
  const directory = mkdtempSync(join(tmpdir(), 'smart-cat-feeder-scheduler-'));
  const store = SqliteLocalStore.open({ databasePath: join(directory, 'device.sqlite') });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const snapshot: LocalScheduleSnapshot = {
    revision: 1,
    generatedAt: utcDateTimeSchema.parse(options.now),
    items: options.schedules,
  };
  store.replaceScheduleSnapshot(snapshot);

  const logger = createJsonLogger({ level: 'error', sink: () => {} });
  const telemetry = new LoggerTelemetry(logger);
  const twin = createDigitalTwin({
    seed: 'scheduler-seed',
    initialTime: options.now,
    autoAdvance: true,
    telemetry,
  });
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
  const orchestrator = new FeedingOrchestrator({
    store,
    executionLock: twin.executionLock,
    motor: twin.motor,
    weightSensor: twin.weightSensor,
    clock: twin.clock,
    deviceStateReporter: reporter,
    telemetry,
    maximumExecutionMs: 30_000,
  });
  const delivery: SchedulerHarness['delivery'] = {
    events: [],
    sawPendingOutbox: false,
  };
  const backendGateway = {
    async reportScheduledFeedingEvent(event: ScheduledFeedingEventRequest) {
      delivery.events.push(event);
      delivery.sawPendingOutbox = store.listPendingOutbox(
        10,
        utcDateTimeSchema.parse('2099-01-01T00:00:00.000Z'),
      ).some((message) => message.aggregateId === event.feeding_id);
      if (options.deliveryFailure) throw options.deliveryFailure;
      return {
        data: {
          feeding_id: event.feeding_id,
          device_id: deviceId,
          schedule_id: event.schedule_id,
          source: 'scheduled' as const,
          status: event.status,
          actual_grams: event.actual_grams,
          received_at: utcDateTimeSchema.parse(twin.clock.now().toISOString()),
        },
        requestId: 'req-scheduled-event',
      };
    },
    close() {},
  } as BackendGateway;
  return {
    store,
    delivery,
    executionLock: twin.executionLock,
    scheduler: new LocalScheduler({
      store,
      backendGateway,
      clock: twin.clock,
      idGenerator: twin.idGenerator,
      feedingOrchestrator: orchestrator,
      telemetry,
      logger,
      tickIntervalMs: 1_000,
      maximumLatenessMs: options.maximumLatenessMs,
    }),
  };
}

function schedule(overrides: Partial<LocalSchedule> = {}): LocalSchedule {
  return {
    scheduleId: firstScheduleId,
    timeLocal: '08:30:00',
    daysOfWeek: daysOfWeekSchema.parse(['mon']),
    timezone: 'UTC',
    portionGrams: 10,
    active: true,
    updatedAt: utcDateTimeSchema.parse('2026-11-23T08:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}
