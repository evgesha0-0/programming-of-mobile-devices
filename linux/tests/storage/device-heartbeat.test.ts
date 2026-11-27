import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { SqliteLocalStore } from '../../src/adapters/storage-sqlite/index.js';
import {
  HeartbeatPayloadConflictError,
  NonMonotonicHeartbeatError,
} from '../../src/ports/index.js';
import { utcDateTimeSchema } from '../../src/domain/index.js';

test('heartbeat payload and delivery metadata survive SQLite restart', (t) => {
  const databasePath = temporaryDatabasePath(t);
  const payload = heartbeat('online', '2026-11-21T06:00:00.000Z');
  const store = SqliteLocalStore.open({ databasePath });

  assert.equal(store.getSchemaVersion(), 3);
  assert.equal(store.getLastHeartbeat(), null);
  store.savePendingHeartbeat(payload);
  assert.deepEqual(store.getLastHeartbeat(), {
    payload,
    deliveryState: 'pending',
    serverTime: null,
    clockOffsetMs: null,
    requestId: null,
  });
  store.close();

  const reopened = SqliteLocalStore.open({ databasePath });
  assert.equal(reopened.getLastHeartbeat()?.deliveryState, 'pending');
  assert.equal(reopened.markHeartbeatDelivered({
    reportedAt: payload.reported_at,
    serverTime: utcDateTimeSchema.parse('2026-11-21T06:00:00.500Z'),
    clockOffsetMs: 250,
    requestId: 'req-state-1',
  }), true);
  assert.deepEqual(reopened.getLastHeartbeat(), {
    payload,
    deliveryState: 'delivered',
    serverTime: '2026-11-21T06:00:00.500Z',
    clockOffsetMs: 250,
    requestId: 'req-state-1',
  });
  reopened.close();
});

test('heartbeat storage rejects stale and conflicting timestamps', (t) => {
  const store = SqliteLocalStore.open({ databasePath: temporaryDatabasePath(t) });
  const current = heartbeat('online', '2026-11-21T06:00:01.000Z');
  store.savePendingHeartbeat(current);

  assert.doesNotThrow(() => store.savePendingHeartbeat(current));
  assert.throws(
    () => store.savePendingHeartbeat(heartbeat('busy', current.reported_at)),
    HeartbeatPayloadConflictError,
  );
  assert.throws(
    () => store.savePendingHeartbeat(heartbeat('online', '2026-11-21T06:00:00.999Z')),
    NonMonotonicHeartbeatError,
  );
  store.close();
});

function heartbeat(status: 'online' | 'busy', reportedAt: string) {
  return {
    status,
    reported_at: utcDateTimeSchema.parse(reportedAt),
    firmware_version: '0.1.0',
    error_code: null,
    error_message: null,
  };
}

function temporaryDatabasePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'smart-cat-feeder-heartbeat-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'device.sqlite');
}
