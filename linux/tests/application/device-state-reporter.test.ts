import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  ClockSkewExceededError,
  DeviceStateReporter,
} from '../../src/application/index.js';
import { SqliteLocalStore } from '../../src/adapters/storage-sqlite/index.js';
import { createJsonLogger } from '../../src/observability/index.js';
import {
  BackendConfigurationError,
  BackendCredentialError,
  BackendTransportError,
  type BackendGateway,
  type BackendGatewayResult,
  type Clock,
} from '../../src/ports/index.js';
import {
  deviceIdSchema,
  utcDateTimeSchema,
} from '../../src/domain/index.js';
import type {
  ReportDeviceStateRequest,
  ReportDeviceStateResponse,
} from '../../src/contracts/index.js';

const deviceId = deviceIdSchema.parse('d6d174f4-e79f-49d1-9476-78bc99483752');
const baseTime = Date.parse('2026-11-21T06:00:00.000Z');

test('reporter keeps reported_at monotonic and persists midpoint clock offset', async (t) => {
  const store = temporaryStore(t);
  const payloads: ReportDeviceStateRequest[] = [];
  const serverTimes = [baseTime + 700, baseTime + 500];
  const gateway = stateGateway(async (payload) => {
    payloads.push(payload);
    const serverTime = serverTimes.shift();
    assert.notEqual(serverTime, undefined);
    return stateResponse(payload, serverTime ?? 0, `req-${payloads.length}`);
  });
  const clock = new ScriptedClock([
    baseTime,
    baseTime + 100,
    baseTime + 300,
    baseTime - 1_000,
    baseTime + 400,
    baseTime + 600,
  ]);
  const reporter = createReporter(store, gateway, clock, 1_000);

  const first = await reporter.reportNow();
  const second = await reporter.reportNow();

  assert.equal(first.clockOffsetMs, 500);
  assert.equal(second.clockOffsetMs, 0);
  assert.equal(
    Date.parse(payloads[1]?.reported_at ?? '') - Date.parse(payloads[0]?.reported_at ?? ''),
    1,
  );
  assert.equal(store.getLastHeartbeat()?.clockOffsetMs, 0);
});

test('reporter retries the exact pending heartbeat after transport failure', async (t) => {
  const store = temporaryStore(t);
  const payloads: ReportDeviceStateRequest[] = [];
  let attempt = 0;
  const gateway = stateGateway(async (payload) => {
    payloads.push(payload);
    attempt += 1;
    if (attempt === 1) throw new BackendTransportError(3, new Error('offline'));
    return stateResponse(payload, baseTime + 25, 'req-retry');
  });
  const clock = new ScriptedClock([
    baseTime,
    baseTime + 10,
    baseTime + 20,
    baseTime + 30,
  ]);
  const reporter = createReporter(store, gateway, clock, 1_000);

  await assert.rejects(reporter.reportNow(), BackendTransportError);
  assert.equal(store.getLastHeartbeat()?.deliveryState, 'pending');
  reporter.setState('busy');
  const delivered = await reporter.reportNow();

  assert.equal(JSON.stringify(payloads[0]), JSON.stringify(payloads[1]));
  assert.equal(delivered.payload.status, 'online');
  assert.equal(store.getLastHeartbeat()?.deliveryState, 'delivered');
});

test('reporter supports online, busy, error and unknown states', (t) => {
  const reporter = createReporter(
    temporaryStore(t),
    stateGateway(async (payload) => stateResponse(payload, baseTime, null)),
    new ScriptedClock([baseTime]),
    1_000,
  );

  assert.equal(reporter.getState().status, 'online');
  reporter.setState('busy');
  assert.equal(reporter.getState().status, 'busy');
  reporter.setState('unknown');
  assert.equal(reporter.getState().status, 'unknown');
  reporter.setState('error', 'WEIGHT_SENSOR_ERROR', 'Sensor is unavailable');
  assert.deepEqual(reporter.getState(), {
    status: 'error',
    errorCode: 'WEIGHT_SENSOR_ERROR',
    errorMessage: 'Sensor is unavailable',
  });
  assert.throws(() => reporter.setState('online', 'MOTOR_ERROR', 'Unexpected error'));
});

test('reporter stores the response then rejects excessive clock skew', async (t) => {
  const store = temporaryStore(t);
  const gateway = stateGateway(async (payload) => stateResponse(
    payload,
    baseTime + 10_000,
    'req-skew',
  ));
  const reporter = createReporter(
    store,
    gateway,
    new ScriptedClock([baseTime, baseTime, baseTime]),
    1_000,
  );

  await assert.rejects(reporter.reportNow(), ClockSkewExceededError);
  assert.equal(store.getLastHeartbeat()?.deliveryState, 'delivered');
  assert.equal(store.getLastHeartbeat()?.requestId, 'req-skew');
});

test('reporter loop treats credential and configuration errors as fatal', async (t) => {
  for (const failure of [
    new BackendCredentialError('req-401', 'UNAUTHORIZED'),
    new BackendConfigurationError('req-403', 'FORBIDDEN'),
  ]) {
    const store = temporaryStore(t);
    const reporter = createReporter(
      store,
      stateGateway(async () => { throw failure; }),
      new ScriptedClock([baseTime, baseTime]),
      1_000,
    );
    await assert.rejects(
      reporter.run(new AbortController().signal),
      (error: unknown) => error === failure,
    );
  }
});

function createReporter(
  store: SqliteLocalStore,
  gateway: BackendGateway,
  clock: Clock,
  maxClockSkewMs: number,
): DeviceStateReporter {
  return new DeviceStateReporter({
    deviceId,
    firmwareVersion: '0.1.0',
    heartbeatIntervalMs: 30_000,
    maxClockSkewMs,
    gateway,
    store,
    clock,
    logger: createJsonLogger({ level: 'error', sink: () => {} }),
  });
}

function stateGateway(
  reportState: (
    payload: ReportDeviceStateRequest,
  ) => Promise<BackendGatewayResult<ReportDeviceStateResponse>>,
): BackendGateway {
  return { reportState, close() {} } as BackendGateway;
}

function stateResponse(
  payload: ReportDeviceStateRequest,
  serverTimeMs: number,
  requestId: string | null,
): BackendGatewayResult<ReportDeviceStateResponse> {
  return {
    data: {
      device_id: deviceId,
      status: payload.status,
      last_seen_at: payload.reported_at,
      server_time: utcDateTimeSchema.parse(new Date(serverTimeMs).toISOString()),
    },
    requestId,
  };
}

class ScriptedClock implements Clock {
  constructor(private readonly times: number[]) {}

  now(): Date {
    const next = this.times.shift();
    if (next === undefined) throw new Error('No scripted clock value');
    return new Date(next);
  }

  async sleep(_delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    throw new Error('Unexpected sleep');
  }
}

function temporaryStore(t: TestContext): SqliteLocalStore {
  const directory = mkdtempSync(join(tmpdir(), 'smart-cat-feeder-reporter-'));
  const store = SqliteLocalStore.open({ databasePath: join(directory, 'device.sqlite') });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}
