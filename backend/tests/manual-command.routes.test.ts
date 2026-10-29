import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommandRepository } from '../src/commands/command.repository.js';
import type { ManualCommandRecord, ManualCommandValues } from '../src/commands/command.types.js';
import type { DeviceRepository } from '../src/devices/device.repository.js';
import type { ScheduleRepository } from '../src/schedules/schedule.repository.js';

const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const missingDeviceId = '4d6b9594-9278-4621-88f3-876b3d127fd8';
const commandId = '1875723f-f6e1-4307-92c8-81577f1ea2fb';

const unusedDeviceRepository: DeviceRepository = {
  async findState() { throw new Error('Device repository must not be used by command routes'); },
  async updateStateIfNewer() { throw new Error('Device repository must not be used by command routes'); },
};

const unusedScheduleRepository: ScheduleRepository = {
  async list() { throw new Error('Schedule repository must not be used by command routes'); },
  async sync() { throw new Error('Schedule repository must not be used by command routes'); },
  async create() { throw new Error('Schedule repository must not be used by command routes'); },
  async update() { throw new Error('Schedule repository must not be used by command routes'); },
  async delete() { throw new Error('Schedule repository must not be used by command routes'); },
};

function memoryRepository(): CommandRepository {
  const commands = new Map<string, ManualCommandRecord>();

  return {
    async create(values) {
      if (values.deviceId !== deviceId) return { kind: 'device_not_found' };
      const existing = commands.get(values.commandId);
      if (existing) {
        return sameCommand(existing, values)
          ? { kind: 'repeated', command: existing }
          : { kind: 'conflict' };
      }
      if (values.expiresAt <= values.createdAt) return { kind: 'invalid_expiry' };

      const command: ManualCommandRecord = {
        commandId: values.commandId,
        feedingId: values.feedingId,
        deviceId: values.deviceId,
        portionGrams: values.portionGrams.toFixed(2),
        status: 'pending',
        createdAt: values.createdAt,
        expiresAt: values.expiresAt,
        startedAt: null,
        finishedAt: null,
        actualGrams: null,
        errorCode: null,
      };
      commands.set(values.commandId, command);
      return { kind: 'created', command };
    },
  };
}

async function appWith(commandRepository = memoryRepository()) {
  return buildApp({
    checkDatabase: async () => undefined,
    commandRepository,
    deviceRepository: unusedDeviceRepository,
    scheduleRepository: unusedScheduleRepository,
  });
}

const validCommand = {
  command_id: commandId,
  portion_grams: 40,
  expires_at: '2099-10-29T03:00:00Z',
};

test('manual command returns 202 when created and 200 for an exact repeat', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const created = await app.inject({
    method: 'POST', url: `/api/v1/devices/${deviceId}/feeding-commands`, payload: validCommand,
  });
  assert.equal(created.statusCode, 202);
  const body = created.json();
  assert.equal(body.command_id, commandId);
  assert.equal(body.device_id, deviceId);
  assert.equal(body.source, 'manual');
  assert.equal(body.portion_grams, 40);
  assert.equal(body.status, 'pending');
  assert.match(body.feeding_id, /^[0-9a-f-]{36}$/);
  assert.equal(body.actual_grams, null);

  const repeated = await app.inject({
    method: 'POST', url: `/api/v1/devices/${deviceId}/feeding-commands`, payload: validCommand,
  });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().feeding_id, body.feeding_id);
  assert.equal(repeated.json().created_at, body.created_at);
});

test('manual command rejects conflicting content under the same command_id', async (t) => {
  const app = await appWith();
  t.after(() => app.close());
  await app.inject({
    method: 'POST', url: `/api/v1/devices/${deviceId}/feeding-commands`, payload: validCommand,
  });

  const conflict = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-commands`,
    payload: { ...validCommand, portion_grams: 50 },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'CONFLICT');
});

test('manual command validates input, expiry and device existence', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  for (const payload of [
    { ...validCommand, command_id: 'not-a-uuid' },
    { ...validCommand, portion_grams: 0 },
    { ...validCommand, portion_grams: 10.001 },
    { ...validCommand, expires_at: 'not-a-date' },
    { ...validCommand, extra: true },
  ]) {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/devices/${deviceId}/feeding-commands`, payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }

  const expired = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-commands`,
    payload: { ...validCommand, command_id: '693df286-f089-463e-848d-5a19f7027449', expires_at: '2000-01-01T00:00:00Z' },
  });
  assert.equal(expired.statusCode, 400);
  assert.equal(expired.json().error.code, 'VALIDATION_ERROR');

  const missing = await app.inject({
    method: 'POST', url: `/api/v1/devices/${missingDeviceId}/feeding-commands`, payload: validCommand,
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'NOT_FOUND');
});

function sameCommand(command: ManualCommandRecord, values: ManualCommandValues): boolean {
  return command.deviceId === values.deviceId
    && Number(command.portionGrams) === values.portionGrams
    && command.expiresAt.getTime() === values.expiresAt.getTime();
}

