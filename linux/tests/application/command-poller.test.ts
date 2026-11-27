import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { SqliteLocalStore } from '../../src/adapters/storage-sqlite/index.js';
import { CommandPoller, type CommandPollerOptions } from '../../src/application/index.js';
import type { PendingCommandsResponse } from '../../src/contracts/index.js';
import { commandIdSchema, deviceIdSchema, feedingIdSchema } from '../../src/domain/index.js';
import { createJsonLogger } from '../../src/observability/index.js';
import { BackendTransportError, type BackendGatewayResult, type Clock } from '../../src/ports/index.js';

type PollResponse = BackendGatewayResult<PendingCommandsResponse>;

const deviceId = deviceIdSchema.parse('d6d174f4-e79f-49d1-9476-78bc99483752');
const otherDeviceId = deviceIdSchema.parse('76b0bed8-f162-486f-94b2-c5f2d1d97d4f');
const pollIntervalMs = 2_500;
const first = {
  command_id: commandIdSchema.parse('ec5391dd-edf4-4341-af87-356f2ac0c6fe'),
  feeding_id: feedingIdSchema.parse('b01f6503-fad1-4d5d-b734-864159d9b1e6'),
  device_id: deviceId,
  portion_grams: 45.57,
  status: 'pending',
  created_at: '2026-11-21T12:00:00.000Z',
  expires_at: '2026-11-21T12:05:00.000Z',
} satisfies PendingCommandsResponse['items'][number];
const second = {
  ...first,
  command_id: commandIdSchema.parse('b1e933b3-523a-44a6-bdcf-56d5eec6bfcb'),
  feeding_id: feedingIdSchema.parse('a552a367-1de4-4381-a238-d93f1f1da654'),
  portion_grams: 20.5,
};
const noWrites = { recordManualCommand: () => assert.fail('Unexpected command write') };

test('empty pending response does not write any commands', async () => {
  await pollResponses(noWrites, response());
});

test('poller persists all commands for its device', async (t) => {
  const store = temporaryStore(t);
  await pollResponses(store, response(first, second));

  for (const item of [first, second]) {
    assert.deepEqual(store.getManualCommand(item.command_id), {
      commandId: item.command_id,
      feedingId: item.feeding_id,
      portionGrams: item.portion_grams,
      createdAt: item.created_at,
      expiresAt: item.expires_at,
    });
  }
});

test('repeated pending response does not insert duplicates', async (t) => {
  const store = temporaryStore(t);
  const inserts: boolean[] = [];
  await pollResponses({
    recordManualCommand(command) {
      const inserted = store.recordManualCommand(command);
      inserts.push(inserted);
      return inserted;
    },
  }, response(first, second), response(first, second));

  assert.deepEqual(inserts, [true, true, false, false]);
});

test('poller rejects a mixed-device response before saving any commands', async () => {
  await assert.rejects(
    pollResponses(noWrites, response(first, { ...second, device_id: otherDeviceId })),
    { name: 'BackendContractError', requestId: 'req-commands' },
  );
});

test('poller recovers from a retryable network failure on the next interval', async (t) => {
  const store = temporaryStore(t);
  await pollResponses(store, new BackendTransportError(3, new Error('offline')), response(first));

  assert.equal(store.getManualCommand(first.command_id)?.feedingId, first.feeding_id);
});

test('poller waits for the active request before sleeping or polling again', async () => {
  const controller = new AbortController();
  let finishRequest!: (result: PollResponse) => void;
  const pending = new Promise<PollResponse>((resolve) => { finishRequest = resolve; });
  const events: string[] = [];
  let requests = 0;
  const poller = createPoller(noWrites, async () => {
    events.push('request');
    requests += 1;
    return requests === 1 ? pending : response();
  }, async (delayMs, signal) => {
    assert.equal(delayMs, pollIntervalMs);
    assert.equal(signal, controller.signal);
    events.push('interval');
    if (requests >= 2) controller.abort();
  });

  const running = poller.run(controller.signal);
  try {
    await assert.rejects(poller.run(controller.signal), /already running/);
    assert.deepEqual(events, ['request']);
    finishRequest(response());
    await running;
    assert.deepEqual(events, ['request', 'interval', 'request', 'interval']);
  } finally {
    controller.abort();
    finishRequest(response());
    await running;
  }
});

function response(...items: PendingCommandsResponse['items']): PollResponse {
  return {
    data: { items, server_time: '2026-11-21T12:00:15.000Z' },
    requestId: 'req-commands',
  };
}

async function pollResponses(
  store: CommandPollerOptions['store'],
  ...responses: Array<PollResponse | BackendTransportError>
): Promise<void> {
  const controller = new AbortController();
  const responseCount = responses.length;
  const intervals: number[] = [];
  const poller = createPoller(store, async () => {
    const next = responses.shift();
    assert.ok(next, 'Unexpected request for pending commands');
    if (next instanceof BackendTransportError) throw next;
    return next;
  }, async (delayMs) => {
    intervals.push(delayMs);
    if (responses.length === 0) controller.abort();
  });

  await poller.run(controller.signal);
  assert.equal(responses.length, 0);
  assert.deepEqual(intervals, Array<number>(responseCount).fill(pollIntervalMs));
}

function createPoller(
  store: CommandPollerOptions['store'],
  getPendingCommands: () => Promise<PollResponse>,
  sleep: Clock['sleep'],
): CommandPoller {
  return new CommandPoller({
    deviceId,
    pollIntervalMs,
    gateway: { getPendingCommands },
    store,
    clock: { sleep },
    logger: createJsonLogger({ level: 'error', sink: () => {} }),
  });
}

function temporaryStore(t: TestContext): SqliteLocalStore {
  const directory = mkdtempSync(join(tmpdir(), 'smart-cat-feeder-commands-'));
  const store = SqliteLocalStore.open({ databasePath: join(directory, 'device.sqlite') });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}
