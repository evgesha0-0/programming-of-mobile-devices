import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import type { DeviceRepository } from '../src/devices/device.repository.js';
import type {
  DeviceStateRecord,
  DeviceStateUpdate,
  UpdatedDeviceStateRecord,
} from '../src/devices/device.types.js';
import type { ScheduleRepository } from '../src/schedules/schedule.repository.js';

const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const unusedScheduleRepository: ScheduleRepository = {
  async list() { throw new Error('Schedule repository must not be used by device routes'); },
  async sync() { throw new Error('Schedule repository must not be used by device routes'); },
  async create() { throw new Error('Schedule repository must not be used by device routes'); },
  async update() { throw new Error('Schedule repository must not be used by device routes'); },
  async delete() { throw new Error('Schedule repository must not be used by device routes'); },
};

function initialState(): DeviceStateRecord {
  return {
    deviceId,
    status: 'error',
    firmwareVersion: '0.1.0',
    lastSeenAt: new Date('2026-10-17T08:15:30Z'),
    scheduleRevision: '12',
    lastErrorCode: 'MOTOR_ERROR',
    lastErrorMessage: 'Motor is blocked',
  };
}

function repository(initial: DeviceStateRecord | null): DeviceRepository {
  let state = initial;

  return {
    async findState(id) {
      return id === deviceId ? state : null;
    },
    async updateStateIfNewer(id, update) {
      if (id !== deviceId || !state || (state.lastSeenAt && state.lastSeenAt >= update.reportedAt)) {
        return null;
      }

      state = applyUpdate(state, update);
      return {
        ...state,
        serverTime: new Date('2026-10-17T08:16:01Z'),
      } satisfies UpdatedDeviceStateRecord;
    },
  };
}

async function appWith(deviceRepository: DeviceRepository) {
  return buildApp({
    checkDatabase: async () => undefined,
    deviceRepository,
    scheduleRepository: unusedScheduleRepository,
  });
}

test('GET device state returns the documented representation', async (t) => {
  const app = await appWith(repository(initialState()));
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${deviceId}/state`,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    device_id: deviceId,
    status: 'error',
    last_seen_at: '2026-10-17T08:15:30.000Z',
    last_error: { code: 'MOTOR_ERROR', message: 'Motor is blocked' },
    schedule_revision: 12,
  });
});

test('device state routes return validation and not-found errors in the common format', async (t) => {
  const app = await appWith(repository(null));
  t.after(() => app.close());

  const invalid = await app.inject({ method: 'GET', url: '/api/v1/devices/not-a-uuid/state' });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'VALIDATION_ERROR');
  assert.equal(typeof invalid.json().error.request_id, 'string');

  const missing = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}/state` });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json().error.code, 'NOT_FOUND');
  assert.equal(missing.body.includes('database'), false);
});

test('PUT device state persists a newer report', async (t) => {
  const deviceRepository = repository(initialState());
  const app = await appWith(deviceRepository);
  t.after(() => app.close());
  const body = {
    status: 'online',
    reported_at: '2026-10-17T08:16:00Z',
    firmware_version: '0.2.0',
    error_code: null,
    error_message: null,
  };

  const response = await app.inject({
    method: 'PUT',
    url: `/api/v1/devices/${deviceId}/state`,
    payload: body,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    device_id: deviceId,
    status: 'online',
    last_seen_at: '2026-10-17T08:16:00.000Z',
    server_time: '2026-10-17T08:16:01.000Z',
  });
  assert.equal((await deviceRepository.findState(deviceId))?.firmwareVersion, '0.2.0');
});

test('PUT device state accepts an exact repeat but rejects stale or conflicting reports', async (t) => {
  const app = await appWith(repository(initialState()));
  t.after(() => app.close());
  const exact = {
    status: 'error',
    reported_at: '2026-10-17T08:15:30Z',
    firmware_version: '0.1.0',
    error_code: 'MOTOR_ERROR',
    error_message: 'Motor is blocked',
  };

  const repeated = await app.inject({
    method: 'PUT', url: `/api/v1/devices/${deviceId}/state`, payload: exact,
  });
  assert.equal(repeated.statusCode, 200);

  for (const payload of [
    { ...exact, reported_at: '2026-10-17T08:15:29Z' },
    { ...exact, status: 'online' },
  ]) {
    const response = await app.inject({
      method: 'PUT', url: `/api/v1/devices/${deviceId}/state`, payload,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'CONFLICT');
  }
});

test('PUT device state rejects offline, invalid timestamps and extra fields', async (t) => {
  const app = await appWith(repository(initialState()));
  t.after(() => app.close());
  const base = {
    status: 'online',
    reported_at: '2026-10-17T08:16:00Z',
    firmware_version: '0.2.0',
    error_code: null,
    error_message: null,
  };

  for (const payload of [
    { ...base, status: 'offline' },
    { ...base, reported_at: 'yesterday' },
    { ...base, secret: 'must-not-be-accepted' },
  ]) {
    const response = await app.inject({
      method: 'PUT', url: `/api/v1/devices/${deviceId}/state`, payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }
});

function applyUpdate(state: DeviceStateRecord, update: DeviceStateUpdate): DeviceStateRecord {
  return {
    ...state,
    status: update.status,
    firmwareVersion: update.firmwareVersion,
    lastSeenAt: update.reportedAt,
    lastErrorCode: update.errorCode,
    lastErrorMessage: update.errorMessage,
  };
}

