import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  ScheduleSnapshotValidationError,
  ScheduleSyncService,
} from '../../src/application/index.js';
import { SqliteLocalStore } from '../../src/adapters/storage-sqlite/index.js';
import { scheduleSyncResponseSchema, type ScheduleSyncResponse } from '../../src/contracts/index.js';
import {
  deviceIdSchema,
  scheduleIdSchema,
} from '../../src/domain/index.js';
import { createJsonLogger } from '../../src/observability/index.js';
import {
  BackendTransportError,
  type BackendGateway,
  type BackendGatewayResult,
  type Clock,
} from '../../src/ports/index.js';

const deviceId = deviceIdSchema.parse('d6d174f4-e79f-49d1-9476-78bc99483752');
const otherDeviceId = deviceIdSchema.parse('76b0bed8-f162-486f-94b2-c5f2d1d97d4f');
const scheduleId = scheduleIdSchema.parse('811f98b6-e0f9-40ad-9b5e-46d501f1a1d3');
const secondScheduleId = scheduleIdSchema.parse('36ee8225-cd00-46ea-b6ef-db9e66c0946b');

test('Android create, update, disable and delete replace the Linux snapshot', async (t) => {
  const knownRevisions: number[] = [];
  const responses = [
    snapshot(1, [item({ portion_grams: 40, active: true, deleted_at: null })]),
    snapshot(2, [item({ portion_grams: 55, active: true, deleted_at: null })]),
    snapshot(3, [item({ portion_grams: 55, active: false, deleted_at: null })]),
    snapshot(4, [item({
      portion_grams: 55,
      active: false,
      deleted_at: '2026-11-21T12:03:00.000Z',
    })]),
  ];
  const gateway = syncGateway(async (knownRevision) => {
    knownRevisions.push(knownRevision);
    const data = responses.shift();
    assert.notEqual(data, undefined);
    return { data: data as ScheduleSyncResponse, requestId: `req-${knownRevision + 1}` };
  });
  const store = temporaryStore(t);
  const service = createService(store, gateway);

  const created = await service.syncNow();
  assert.equal(created.changed, true);
  assert.equal(store.getScheduleSnapshot()?.items[0]?.portionGrams, 40);

  await service.syncNow();
  assert.equal(store.getScheduleSnapshot()?.items[0]?.portionGrams, 55);

  await service.syncNow();
  assert.equal(store.getScheduleSnapshot()?.items[0]?.active, false);
  assert.equal(store.getScheduleSnapshot()?.items[0]?.deletedAt, null);

  const deleted = await service.syncNow();
  assert.equal(deleted.revision, 4);
  assert.equal(store.getScheduleSnapshot()?.revision, 4);
  assert.equal(
    store.getScheduleSnapshot()?.items[0]?.deletedAt,
    '2026-11-21T12:03:00.000Z',
  );
  assert.deepEqual(knownRevisions, [0, 1, 2, 3]);
});

test('sync always treats the response as a complete snapshot', async (t) => {
  const responses = [
    snapshot(1, [item(), item({ schedule_id: secondScheduleId, time_local: '09:30:00' })]),
    snapshot(2, [item({ portion_grams: 45 })]),
  ];
  const store = temporaryStore(t);
  const service = createService(store, syncGateway(async () => ({
    data: responses.shift() as ScheduleSyncResponse,
    requestId: null,
  })));

  await service.syncNow();
  assert.equal(store.getScheduleSnapshot()?.items.length, 2);
  await service.syncNow();
  assert.equal(store.getScheduleSnapshot()?.items.length, 1);
  assert.equal(store.getScheduleSnapshot()?.items[0]?.portionGrams, 45);
});

test('foreign device snapshot leaves the previous revision untouched', async (t) => {
  const responses = [
    snapshot(5, [item()]),
    snapshot(6, [item({ portion_grams: 60 })], otherDeviceId),
  ];
  const store = temporaryStore(t);
  const service = createService(store, syncGateway(async () => ({
    data: responses.shift() as ScheduleSyncResponse,
    requestId: 'req-device-mismatch',
  })));

  await service.syncNow();
  const previous = store.getScheduleSnapshot();
  await assert.rejects(service.syncNow(), ScheduleSnapshotValidationError);
  assert.deepEqual(store.getScheduleSnapshot(), previous);
});

test('one invalid item rejects the full snapshot before SQLite replacement', async (t) => {
  const valid = snapshot(7, [item()]);
  const invalid = {
    ...snapshot(8, [item(), item({ schedule_id: secondScheduleId })]),
    items: [
      item(),
      { ...item({ schedule_id: secondScheduleId }), timezone: 'Not/A-Timezone' },
    ],
  } as unknown as ScheduleSyncResponse;
  const responses = [valid, invalid];
  const store = temporaryStore(t);
  const service = createService(store, syncGateway(async () => ({
    data: responses.shift() as ScheduleSyncResponse,
    requestId: 'req-invalid-item',
  })));

  await service.syncNow();
  const previous = store.getScheduleSnapshot();
  await assert.rejects(service.syncNow(), ScheduleSnapshotValidationError);
  assert.deepEqual(store.getScheduleSnapshot(), previous);
});

test('transport failure leaves the previous snapshot untouched', async (t) => {
  const store = temporaryStore(t);
  const responses: Array<ScheduleSyncResponse | Error> = [
    snapshot(9, [item()]),
    new BackendTransportError(3, new Error('offline')),
  ];
  const service = createService(store, syncGateway(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { data: next as ScheduleSyncResponse, requestId: null };
  }));

  await service.syncNow();
  const previous = store.getScheduleSnapshot();
  await assert.rejects(service.syncNow(), BackendTransportError);
  assert.deepEqual(store.getScheduleSnapshot(), previous);
});

test('periodic sync keeps the last snapshot after retryable failure and continues', async (t) => {
  const store = temporaryStore(t);
  const controller = new AbortController();
  let attempts = 0;
  let sleeps = 0;
  const clock: Clock = {
    now: () => new Date('2026-11-21T12:00:00.000Z'),
    async sleep() {
      sleeps += 1;
      if (sleeps === 2) controller.abort();
    },
  };
  const service = createService(store, syncGateway(async () => {
    attempts += 1;
    if (attempts === 1) throw new BackendTransportError(3, new Error('offline'));
    return { data: snapshot(10, [item()]), requestId: 'req-recovered' };
  }), clock);

  await service.run(controller.signal);

  assert.equal(attempts, 2);
  assert.equal(store.getScheduleSnapshot()?.revision, 10);
});

function createService(
  store: SqliteLocalStore,
  gateway: BackendGateway,
  clock: Clock = noSleepClock,
): ScheduleSyncService {
  return new ScheduleSyncService({
    deviceId,
    syncIntervalMs: 60_000,
    gateway,
    store,
    clock,
    logger: createJsonLogger({ level: 'error', sink: () => {} }),
  });
}

function syncGateway(
  syncSchedules: (
    knownRevision: number,
  ) => Promise<BackendGatewayResult<ScheduleSyncResponse>>,
): BackendGateway {
  return { syncSchedules, close() {} } as BackendGateway;
}

function snapshot(
  revision: number,
  items: unknown[],
  snapshotDeviceId = deviceId,
): ScheduleSyncResponse {
  return scheduleSyncResponseSchema.parse({
    device_id: snapshotDeviceId,
    schedule_revision: revision,
    generated_at: `2026-11-21T12:${String(revision).padStart(2, '0')}:00.000Z`,
    items,
  });
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schedule_id: scheduleId,
    time_local: '08:30:00',
    days_of_week: ['mon', 'wed', 'fri'],
    timezone: 'Asia/Yekaterinburg',
    portion_grams: 40,
    active: true,
    updated_at: '2026-11-21T12:00:00.000Z',
    deleted_at: null,
    ...overrides,
  };
}

const noSleepClock: Clock = {
  now: () => new Date('2026-11-21T12:00:00.000Z'),
  sleep: async () => { throw new Error('Unexpected sleep'); },
};

function temporaryStore(t: TestContext): SqliteLocalStore {
  const directory = mkdtempSync(join(tmpdir(), 'smart-cat-feeder-schedules-'));
  const store = SqliteLocalStore.open({ databasePath: join(directory, 'device.sqlite') });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}
