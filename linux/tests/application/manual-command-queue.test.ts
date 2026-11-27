import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { SqliteLocalStore } from '../../src/adapters/storage-sqlite/index.js';
import { ManualCommandQueue } from '../../src/application/index.js';
import { commandIdSchema, feedingIdSchema } from '../../src/domain/index.js';
import type { BackendGateway, ManualCommand } from '../../src/ports/index.js';

const baseTime = Date.parse('2026-11-21T06:00:00.000Z');
const first: ManualCommand = {
  commandId: commandIdSchema.parse('ec5391dd-edf4-4341-af87-356f2ac0c6fe'),
  feedingId: feedingIdSchema.parse('b01f6503-fad1-4d5d-b734-864159d9b1e6'),
  portionGrams: 45.57,
  createdAt: timestamp(baseTime - 60_000),
  expiresAt: timestamp(baseTime + 5_000),
};
const second: ManualCommand = {
  ...first,
  commandId: commandIdSchema.parse('b1e933b3-523a-44a6-bdcf-56d5eec6bfcb'),
  feedingId: feedingIdSchema.parse('a552a367-1de4-4381-a238-d93f1f1da654'),
  createdAt: timestamp(baseTime - 30_000),
  expiresAt: timestamp(baseTime + 10_000),
};

test('queue skips an already expired command without removing its journal entry', async (t) => {
  const store = temporaryStore(t);
  const expired = { ...first, expiresAt: timestamp(baseTime - 1) };
  store.recordManualCommand(expired);
  store.recordManualCommand(second);
  deliverHeartbeat(store, 0);
  const queue = createQueue(store);

  assert.deepEqual(queue.getNext(), second);
  assert.equal(await queue.acknowledgeFirst(expired.commandId), null);
  assert.deepEqual(store.getManualCommand(expired.commandId), expired);
});

test('a command that expires exactly at server time is not selected or acknowledged', async (t) => {
  const store = temporaryStore(t);
  store.recordManualCommand({ ...first, expiresAt: '2026-11-21T06:00:00Z' });
  deliverHeartbeat(store, 0);
  const queue = createQueue(store);

  assert.equal(queue.getNext(), null);
  assert.equal(await queue.acknowledgeFirst(first.commandId), null);
});

test('the first ack rechecks a command that has been waiting in the local queue', async (t) => {
  const store = temporaryStore(t);
  store.recordManualCommand(second);
  store.recordManualCommand(first);
  deliverHeartbeat(store, 0);
  let now = baseTime;
  const queue = createQueue(store, () => new Date(now));

  const selected = queue.getNext();
  assert.deepEqual(selected, first);
  now = baseTime + 5_001;
  assert.equal(await queue.acknowledgeFirst(first.commandId), null);
  assert.deepEqual(queue.getNext(), second);
});

test('selection and first ack use the latest heartbeat when the device clock is behind', async (t) => {
  const store = temporaryStore(t);
  store.recordManualCommand(first);
  store.recordManualCommand(second);
  deliverHeartbeat(store, 0);
  const queue = createQueue(store);
  assert.deepEqual(queue.getNext(), first);

  deliverHeartbeat(store, 7_000, baseTime - 1_000);
  assert.equal(await queue.acknowledgeFirst(first.commandId), null);
  assert.deepEqual(queue.getNext(), second);
});

test('a device clock ahead of the server does not expire a still valid command', async (t) => {
  const store = temporaryStore(t);
  store.recordManualCommand(first);
  deliverHeartbeat(store, -3_000);
  const queue = createQueue(store, () => new Date(baseTime + 7_000), async (commandId, request) => {
    assert.equal(commandId, first.commandId);
    assert.deepEqual(request, {
      feeding_id: first.feedingId,
      status: 'running',
      started_at: timestamp(baseTime + 4_000),
    });
    return { data: { command_id: commandId, ...request }, requestId: 'req-ack' };
  });

  assert.deepEqual(queue.getNext(), first);
  assert.equal((await queue.acknowledgeFirst(first.commandId))?.requestId, 'req-ack');
});

test('queue waits for a heartbeat with a usable clock offset', async (t) => {
  const store = temporaryStore(t);
  store.recordManualCommand(first);
  const queue = createQueue(store);

  assert.equal(queue.getNext(), null);
  assert.equal(await queue.acknowledgeFirst(first.commandId), null);

  deliverHeartbeat(store, -30_001);
  assert.equal(queue.getNext(), null);
  assert.equal(await queue.acknowledgeFirst(first.commandId), null);

  deliverHeartbeat(store, 0, baseTime - 1_000);
  assert.deepEqual(queue.getNext(), first);
});

function createQueue(
  store: SqliteLocalStore,
  now: () => Date = () => new Date(baseTime),
  acknowledgeCommand: BackendGateway['acknowledgeCommand'] = async () => assert.fail('Unexpected ack'),
): ManualCommandQueue {
  return new ManualCommandQueue({ store, gateway: { acknowledgeCommand }, clock: { now }, maxClockSkewMs: 30_000 });
}

function deliverHeartbeat(store: SqliteLocalStore, clockOffsetMs: number, sentAt = baseTime - 10_000): void {
  const reportedAt = timestamp(sentAt);
  store.savePendingHeartbeat({
    status: 'online',
    reported_at: reportedAt,
    firmware_version: '0.1.0',
    error_code: null,
    error_message: null,
  });
  assert.equal(store.markHeartbeatDelivered({
    reportedAt,
    serverTime: timestamp(sentAt + clockOffsetMs),
    clockOffsetMs,
    requestId: 'req-heartbeat',
  }), true);
}

function timestamp(time: number): string {
  return new Date(time).toISOString();
}

function temporaryStore(t: TestContext): SqliteLocalStore {
  const directory = mkdtempSync(join(tmpdir(), 'smart-cat-feeder-command-queue-'));
  const store = SqliteLocalStore.open({ databasePath: join(directory, 'device.sqlite') });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}
