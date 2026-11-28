import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { HttpBackendGateway } from '../../src/adapters/backend-http/index.js';
import { SqliteLocalStore } from '../../src/adapters/storage-sqlite/index.js';
import { OutboxDeliveryService } from '../../src/application/index.js';
import { deviceApiPaths, scheduledFeedingEventRequestSchema } from '../../src/contracts/index.js';
import { commandIdSchema, deviceIdSchema, feedingIdSchema, scheduleIdSchema, type FeedingId } from '../../src/domain/index.js';
import { createJsonLogger } from '../../src/observability/index.js';
import { BackendGatewayError, type Clock, type NewOutboxMessage } from '../../src/ports/index.js';
import { VirtualClock } from '../../src/simulator/index.js';

const deviceId = deviceIdSchema.parse('d6d174f4-e79f-49d1-9476-78bc99483752');
const otherDeviceId = deviceIdSchema.parse('76b0bed8-f162-486f-94b2-c5f2d1d97d4f');
const manualId = feedingIdSchema.parse('b01f6503-fad1-4d5d-b734-864159d9b1e6');
const scheduledId = feedingIdSchema.parse('a552a367-1de4-4381-a238-d93f1f1da654');
const commandId = commandIdSchema.parse('ec5391dd-edf4-4341-af87-356f2ac0c6fe');
const scheduleId = scheduleIdSchema.parse('36ee8225-cd00-46ea-b6ef-db9e66c0946b');
const initialTime = '2026-11-21T06:00:08.000Z';
const initialMs = Date.parse(initialTime);
const startedAt = '2026-11-21T06:00:03.000Z';
const retryDelayMs = 100;
const pollIntervalMs = 1_000;

for (const kind of ['manual_result', 'scheduled_event'] as const) {
  test(`${kind} already stored by backend is replayed verbatim after a lost response and restart`, async (t) => {
    const { store, reopen } = temporaryStore(t);
    const fixture = resultFixture(kind, kind === 'manual_result' ? manualId : scheduledId);
    const rowId = store.enqueueOutbox(fixture.message);
    const clock = new VirtualClock(initialTime);
    const history = new Map<string, string>();
    const requests: Array<{ path: string; body: string }> = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      const request = postedRequest(input, init);
      requests.push(request);
      const feedingId = kind === 'manual_result'
        ? request.path.split('/').at(-2)
        : scheduledFeedingEventRequestSchema.parse(JSON.parse(request.body)).feeding_id;
      assert.ok(feedingId);
      const saved = history.get(feedingId);
      if (saved === undefined) {
        history.set(feedingId, request.body);
        throw new TypeError('Response lost after recording the feeding');
      }
      if (saved !== request.body) return new Response(null, { status: 409 });
      return Response.json(fixture.confirmation);
    };
    const signal = new AbortController().signal;
    await delivery(t, store, clock, fetchImplementation).tick(signal);
    assert.equal(requests.length, 1);
    assert.deepEqual([...history.keys()], [fixture.message.aggregateId]);
    const pending = store.getOutboxMessage(rowId);
    assert.equal(pending?.attemptCount, 1);
    assert.equal(pending.deliveredAt, null);
    assert.equal(pending.failedAt, null);
    assert.equal(pending.nextAttemptAt, new Date(initialMs + retryDelayMs).toISOString());
    assert.equal(pending.payload, fixture.message.payload);

    const restored = reopen();
    assert.deepEqual(restored.getOutboxMessage(rowId), pending);
    const controller = new AbortController();
    const restarted = delivery(t, restored, {
      now: () => clock.now(),
      async sleep(delay) {
        assert.equal(delay, pollIntervalMs);
        controller.abort();
      },
    }, fetchImplementation);
    await restarted.tick(signal);
    assert.equal(requests.length, 1);
    await clock.advanceTo(pending.nextAttemptAt);
    await restarted.run(controller.signal);
    await restarted.tick(signal);

    const expectedRequest = { path: fixture.path, body: fixture.message.payload };
    assert.deepEqual(requests, [expectedRequest, expectedRequest]);
    assert.deepEqual([...history.entries()], [[fixture.message.aggregateId, fixture.message.payload]]);
    assert.equal(restored.getOutboxMessage(rowId)?.deliveredAt, clock.now().toISOString());
    assert.equal(restored.getOutboxMessage(rowId)?.lastError, null);
    assert.deepEqual(restored.listPendingOutbox(10, '2099-01-01T00:00:00.000Z'), []);
  });
}

test('429 and 5xx responses persist a capped delay before each next attempt', async (t) => {
  const { store } = temporaryStore(t);
  const fixture = resultFixture('scheduled_event', scheduledId);
  const rowId = store.enqueueOutbox(fixture.message);
  const clock = new VirtualClock(initialTime);
  const statuses = [429, 503, 500];
  let requests = 0;
  const service = delivery(t, store, clock, async (input, init) => {
    assert.deepEqual(postedRequest(input, init), { path: fixture.path, body: fixture.message.payload });
    const status = statuses[requests++];
    return status === undefined ? Response.json(fixture.confirmation) : new Response(null, { status });
  });
  const signal = new AbortController().signal;

  for (const [index, delay] of [100, 200, 250].entries()) {
    const nextAttemptAt = new Date(clock.now().getTime() + delay).toISOString();
    await service.tick(signal);
    const entry = store.getOutboxMessage(rowId);
    assert.equal(entry?.attemptCount, index + 1);
    assert.equal(entry.nextAttemptAt, nextAttemptAt);
    assert.match(entry.lastError ?? '', new RegExp(`HTTP ${statuses[index]}`));
    assert.equal(entry.deliveredAt, null);
    assert.equal(entry.failedAt, null);
    await clock.advanceBy(delay - 1);
    await service.tick(signal);
    assert.equal(requests, index + 1);
    await clock.advanceBy(1);
  }
  await service.tick(signal);
  assert.equal(requests, 4);
  assert.equal(store.getOutboxMessage(rowId)?.deliveredAt, clock.now().toISOString());
});

test('401 and 403 log access problems and leave the entire remaining queue untouched', async (t) => {
  const { store } = temporaryStore(t);
  store.enqueueOutbox(resultFixture('manual_result', manualId).message);
  store.enqueueOutbox(resultFixture('scheduled_event', scheduledId).message);
  const before = store.listPendingOutbox(10, initialTime);
  const clock = new VirtualClock(initialTime);

  for (const status of [401, 403]) {
    let requests = 0;
    const lines: string[] = [];
    const service = delivery(t, store, clock, async () => {
      requests += 1;
      return new Response(null, { status, headers: { 'content-length': '2000000' } });
    }, lines);
    await assert.rejects(service.tick(new AbortController().signal),
      (error) => error instanceof BackendGatewayError && error.statusCode === status);
    assert.equal(requests, 1);
    assert.deepEqual(store.listPendingOutbox(10, initialTime), before);
    assert.ok(lines.some((line) => line.includes('outbox_delivery_access_denied') && line.includes(`"statusCode":${status}`)));
  }
});

test('409 and invalid messages or responses do not block later eligible deliveries', async (t) => {
  const { store, reopen } = temporaryStore(t);
  const manual = resultFixture('manual_result', manualId);
  const scheduled = resultFixture('scheduled_event', scheduledId);
  const otherSchedule = resultFixture('scheduled_event', manualId);
  const unsupportedId = store.enqueueOutbox({ ...manual.message, kind: 'state' });
  const invalidId = store.enqueueOutbox({ ...manual.message, aggregateId: scheduledId, payload: '{}' });
  const conflictId = store.enqueueOutbox(manual.message);
  const mismatchId = store.enqueueOutbox(scheduled.message);
  const deliveredId = store.enqueueOutbox(otherSchedule.message);
  const responses = [
    new Response(null, { status: 409 }),
    Response.json({ ...scheduled.confirmation, device_id: otherDeviceId }),
    Response.json(otherSchedule.confirmation),
  ];
  const requests: Array<{ path: string; body: string }> = [];
  const clock = new VirtualClock(initialTime);
  const service = delivery(t, store, clock, async (input, init) => {
    requests.push(postedRequest(input, init));
    const response = responses.shift();
    assert.ok(response, 'Unexpected outbox delivery');
    return response;
  });
  const signal = new AbortController().signal;
  await service.tick(signal);
  assert.deepEqual(requests, [manual, scheduled, otherSchedule].map(({ path, message }) => ({ path, body: message.payload })));

  const restored = reopen();
  for (const id of [invalidId, conflictId, mismatchId]) {
    const entry = restored.getOutboxMessage(id);
    assert.equal(entry?.failedAt, initialTime);
    assert.equal(entry.deliveredAt, null);
  }
  assert.match(restored.getOutboxMessage(invalidId)?.lastError ?? '', /payload/);
  assert.match(restored.getOutboxMessage(conflictId)?.lastError ?? '', /conflicting/);
  assert.equal(restored.getOutboxMessage(conflictId)?.payload, manual.message.payload);
  assert.match(restored.getOutboxMessage(mismatchId)?.lastError ?? '', /device contract/);
  assert.equal(restored.getOutboxMessage(deliveredId)?.deliveredAt, initialTime);
  await delivery(t, restored, clock, async () => assert.fail('No eligible results remain')).tick(signal);
  assert.deepEqual(restored.listPendingOutbox(10, initialTime).map(({ id }) => id), [unsupportedId]);
});

function resultFixture(kind: 'manual_result' | 'scheduled_event', feedingId: FeedingId) {
  const result = { status: 'completed', actual_grams: 39.5 };
  const terminal = {
    ...result, portion_grams: 40, started_at: startedAt, finished_at: initialTime, error_code: null, error_message: null,
  };
  const manual = kind === 'manual_result';
  const source = manual ? 'manual' : 'scheduled';
  const body = manual
    ? { ...terminal, source, command_id: commandId }
    : { ...terminal, source, feeding_id: feedingId, schedule_id: scheduleId, created_at: startedAt };
  const message: NewOutboxMessage = {
    kind,
    aggregateId: feedingId,
    payload: `${JSON.stringify(body, null, 2)}\n`,
    createdAt: initialTime,
    nextAttemptAt: initialTime,
  };
  return {
    message,
    path: manual ? deviceApiPaths.feedingResult(deviceId, feedingId) : deviceApiPaths.feedingEvents(deviceId),
    confirmation: manual
      ? { ...result, feeding_id: feedingId, command_id: commandId, finished_at: initialTime }
      : { ...result, feeding_id: feedingId, device_id: deviceId, schedule_id: scheduleId, source, received_at: initialTime },
  };
}

function postedRequest(input: Parameters<typeof fetch>[0], init?: RequestInit): { path: string; body: string } {
  assert.equal(init?.method, 'POST');
  const body = init?.body;
  assert.ok(typeof body === 'string');
  return { path: new URL(String(input)).pathname, body };
}

function temporaryStore(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'smart-cat-feeder-outbox-'));
  const databasePath = join(directory, 'device.sqlite');
  let store = SqliteLocalStore.open({ databasePath });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    reopen() {
      store.close();
      store = SqliteLocalStore.open({ databasePath });
      return store;
    },
  };
}

function delivery(t: TestContext, store: SqliteLocalStore, clock: Clock, fetchImplementation: typeof fetch, lines: string[] = []) {
  const gateway = new HttpBackendGateway({
    backendUrl: 'https://backend.example.test',
    deviceId,
    deviceToken: `dvc_${'A'.repeat(43)}`,
    requestTimeoutMs: 1_000,
    backoffInitialMs: 1,
    backoffMaxMs: 2,
    fetchImplementation,
  });
  t.after(() => gateway.close());
  return new OutboxDeliveryService({
    deviceId,
    store,
    gateway,
    clock,
    logger: createJsonLogger({ level: 'warn', sink: (line) => lines.push(line) }),
    pollIntervalMs,
    backoffInitialMs: retryDelayMs,
    backoffMaxMs: 250,
  });
}
