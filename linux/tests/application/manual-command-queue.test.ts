import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import { HttpBackendGateway } from '../../src/adapters/backend-http/index.js';
import { SqliteLocalStore } from '../../src/adapters/storage-sqlite/index.js';
import { ManualCommandQueue } from '../../src/application/index.js';
import type { AcknowledgeCommandResponse } from '../../src/contracts/index.js';
import { commandIdSchema, deviceIdSchema, feedingIdSchema } from '../../src/domain/index.js';
import {
  BackendConflictError,
  BackendContractError,
  BackendHttpError,
  BackendTransportError,
  type BackendGateway,
  type ManualCommand,
} from '../../src/ports/index.js';

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

test('a lost ack response is reconciled with the exact request after SQLite reopens and the command expires', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'smart-cat-feeder-ack-restart-'));
  const databasePath = join(directory, 'device.sqlite');
  let store = SqliteLocalStore.open({ databasePath });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.recordManualCommand(first);
  deliverHeartbeat(store, 0);

  const deviceId = deviceIdSchema.parse('d6d174f4-e79f-49d1-9476-78bc99483752');
  const path = `/api/v1/devices/${deviceId}/commands/${first.commandId}/ack`;
  const payload = { feeding_id: first.feedingId, status: 'running', started_at: timestamp(baseTime) };
  const requests: Array<{ path: string; body: string }> = [];
  let acceptedBody: string | undefined;
  const fetchImplementation: typeof fetch = async (input, init) => {
    assert.equal(init?.method, 'POST');
    const body = init?.body;
    assert.ok(typeof body === 'string');
    requests.push({ path: new URL(String(input)).pathname, body });
    assert.deepEqual(store.getNextPendingManualAck(), {
      commandId: first.commandId,
      feedingId: first.feedingId,
      expiresAt: first.expiresAt,
      startedAt: payload.started_at,
    });
    if (acceptedBody === undefined) {
      // The backend committed the ack before the response was lost.
      acceptedBody = body;
      throw new DOMException('Ack response timed out', 'TimeoutError');
    }
    assert.equal(body, acceptedBody);
    return Response.json({ command_id: first.commandId, ...payload }, {
      headers: { 'x-request-id': 'req-reconciled' },
    });
  };
  const gatewayOptions = {
    backendUrl: 'https://backend.example.test',
    deviceId,
    deviceToken: `dvc_${'A'.repeat(43)}`,
    requestTimeoutMs: 1_000,
    backoffInitialMs: 100,
    backoffMaxMs: 100,
    maxAttempts: 1,
    fetchImplementation,
  };
  const firstGateway = new HttpBackendGateway(gatewayOptions);
  t.after(() => firstGateway.close());
  const queue = createQueue(store, undefined, firstGateway.acknowledgeCommand.bind(firstGateway));
  await assert.rejects(queue.acknowledgeFirst(first.commandId), BackendTransportError);
  assert.equal(acceptedBody, JSON.stringify(payload));
  assert.equal(store.getFeeding(first.feedingId), null);
  firstGateway.close();
  store.close();

  store = SqliteLocalStore.open({ databasePath });
  const restartedGateway = new HttpBackendGateway(gatewayOptions);
  t.after(() => restartedGateway.close());
  const restarted = createQueue(
    store,
    () => new Date(baseTime + 60_000),
    restartedGateway.acknowledgeCommand.bind(restartedGateway),
  );
  assert.equal(restarted.getNext(), null);
  assert.equal((await restarted.retryPendingAck())?.requestId, 'req-reconciled');
  assert.equal(await restarted.retryPendingAck(), null);
  assert.deepEqual(requests, [
    { path, body: JSON.stringify(payload) },
    { path, body: JSON.stringify(payload) },
  ]);

  const reader = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = reader.prepare('SELECT phase, ack_started_at FROM commands WHERE command_id = ?').get(first.commandId);
    assert.equal(row?.phase, 'acked');
    assert.equal(row?.ack_started_at, payload.started_at);
  } finally {
    reader.close();
  }
});

test('a command-level refusal removes the ack from the retry queue', async (t) => {
  const refusals = [
    new BackendConflictError('req-conflict', 'CONFLICT'),
    ...[400, 404].map((statusCode) => new BackendHttpError({
      statusCode,
      requestId: 'req-refused',
      backendCode: null,
      retryable: false,
      attempts: 1,
    })),
  ];
  for (const refusal of refusals) {
    const store = temporaryStore(t);
    store.recordManualCommand(first);
    store.recordManualCommand(second);
    deliverHeartbeat(store, 0);
    const queue = createQueue(store, undefined, async () => { throw refusal; });

    await assert.rejects(queue.acknowledgeFirst(first.commandId), (error) => error === refusal);
    assert.equal(await queue.retryPendingAck(), null);
    assert.equal(await queue.acknowledgeFirst(first.commandId), null);
    assert.deepEqual(queue.getNext(), second);
  }
});

test('an ack response with mismatched fields cannot resolve the intent', async (t) => {
  for (const mismatch of [
    { command_id: second.commandId },
    { feeding_id: second.feedingId },
    { status: 'completed' },
    { started_at: timestamp(baseTime + 1) },
  ]) {
    const store = temporaryStore(t);
    store.recordManualCommand(first);
    deliverHeartbeat(store, 0);
    const queue = createQueue(store, undefined, async (commandId, request) => ({
      data: { command_id: commandId, ...request, ...mismatch } as AcknowledgeCommandResponse,
      requestId: 'req-mismatch',
    }));

    await assert.rejects(queue.acknowledgeFirst(first.commandId), BackendContractError);
    assert.equal(store.getNextPendingManualAck()?.startedAt, timestamp(baseTime));
  }
});

test('expiry during the durable write does not send or retry an unattempted ack', async (t) => {
  const store = temporaryStore(t);
  store.recordManualCommand(first);
  deliverHeartbeat(store, 0);
  const times = [baseTime + 4_999, baseTime + 5_000];
  const queue = createQueue(store, () => new Date(times.shift() ?? baseTime + 5_000));

  assert.equal(await queue.acknowledgeFirst(first.commandId), null);
  assert.equal(await queue.retryPendingAck(), null);
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
