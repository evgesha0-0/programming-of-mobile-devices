import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommandRepository } from '../src/commands/command.repository.js';
import type { DeviceRepository } from '../src/devices/device.repository.js';
import type { ScheduleRepository } from '../src/schedules/schedule.repository.js';
import type { ScheduleRecord, ScheduleValues } from '../src/schedules/schedule.types.js';

const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const missingDeviceId = '4d6b9594-9278-4621-88f3-876b3d127fd8';
const missingScheduleId = 'ee681479-a7cf-4afb-b7a7-ddc70bb22120';
const now = new Date('2026-10-29T02:00:00Z');
const unusedCommandRepository: CommandRepository = {
  async create() { throw new Error('Command repository must not be used by schedule routes'); },
};

const unusedDeviceRepository: DeviceRepository = {
  async findState() { throw new Error('Device repository must not be used by schedule routes'); },
  async updateStateIfNewer() { throw new Error('Device repository must not be used by schedule routes'); },
};

function memoryRepository(): ScheduleRepository {
  let revision = 0;
  const schedules = new Map<string, ScheduleRecord>();

  return {
    async list(id) {
      if (id !== deviceId) return null;
      return {
        scheduleRevision: String(revision),
        items: [...schedules.values()].filter((item) => item.deletedAt === null),
      };
    },
    async sync(id) {
      if (id !== deviceId) return null;
      return {
        scheduleRevision: String(revision),
        generatedAt: new Date('2026-10-29T02:15:00Z'),
        items: [...schedules.values()],
      };
    },
    async create(id, scheduleId, values) {
      if (id !== deviceId) return null;
      revision += 1;
      const schedule = record(scheduleId, values, revision);
      schedules.set(scheduleId, schedule);
      return schedule;
    },
    async update(id, scheduleId, values) {
      const current = schedules.get(scheduleId);
      if (id !== deviceId || !current || current.deletedAt) return null;
      revision += 1;
      const schedule = {
        ...current,
        ...recordValues(values),
        revision: String(revision),
        updatedAt: new Date('2026-10-29T02:05:00Z'),
      };
      schedules.set(scheduleId, schedule);
      return schedule;
    },
    async delete(id, scheduleId) {
      const current = schedules.get(scheduleId);
      if (id !== deviceId || !current || current.deletedAt) return null;
      revision += 1;
      const deletedAt = new Date('2026-10-29T02:10:00Z');
      schedules.set(scheduleId, {
        ...current,
        revision: String(revision),
        updatedAt: deletedAt,
        deletedAt,
      });
      return { scheduleId, scheduleRevision: String(revision), deletedAt };
    },
  };
}

async function appWith(repository = memoryRepository()) {
  return buildApp({
    checkDatabase: async () => undefined,
    commandRepository: unusedCommandRepository,
    deviceRepository: unusedDeviceRepository,
    scheduleRepository: repository,
  });
}

const validSchedule = {
  time_local: '08:30:00',
  days_of_week: ['mon', 'wed', 'fri'],
  timezone: 'Asia/Vladivostok',
  portion_grams: 45.5,
  active: true,
};

test('schedule CRUD increments revision and hides a soft-deleted schedule', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const empty = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}/schedules` });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), { device_id: deviceId, schedule_revision: 0, items: [] });

  const created = await app.inject({
    method: 'POST', url: `/api/v1/devices/${deviceId}/schedules`, payload: validSchedule,
  });
  assert.equal(created.statusCode, 201);
  const createdBody = created.json();
  assert.match(createdBody.schedule_id, /^[0-9a-f-]{36}$/);
  assert.equal(createdBody.device_id, deviceId);
  assert.equal(createdBody.schedule_revision, 1);
  assert.equal(createdBody.portion_grams, 45.5);

  const changed = { ...validSchedule, time_local: '09:00:00', active: false };
  const updated = await app.inject({
    method: 'PUT',
    url: `/api/v1/devices/${deviceId}/schedules/${createdBody.schedule_id}`,
    payload: changed,
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().schedule_revision, 2);
  assert.equal(updated.json().time_local, '09:00:00');
  assert.equal(updated.json().active, false);

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/v1/devices/${deviceId}/schedules/${createdBody.schedule_id}`,
  });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.json(), {
    schedule_id: createdBody.schedule_id,
    deleted: true,
    schedule_revision: 3,
    deleted_at: '2026-10-29T02:10:00.000Z',
  });

  const afterDelete = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}/schedules` });
  assert.equal(afterDelete.json().schedule_revision, 3);
  assert.deepEqual(afterDelete.json().items, []);
});

test('schedule routes reject invalid input without calling the database', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  for (const payload of [
    { ...validSchedule, time_local: '24:00:00' },
    { ...validSchedule, days_of_week: ['mon', 'mon'] },
    { ...validSchedule, days_of_week: [] },
    { ...validSchedule, portion_grams: 0 },
    { ...validSchedule, portion_grams: 10.001 },
    { ...validSchedule, extra: true },
    { ...validSchedule, timezone: 'Not/A-Timezone' },
  ]) {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/devices/${deviceId}/schedules`, payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }
});

test('schedule routes distinguish an unknown device and schedule', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const missingDevice = await app.inject({
    method: 'GET', url: `/api/v1/devices/${missingDeviceId}/schedules`,
  });
  assert.equal(missingDevice.statusCode, 404);
  assert.equal(missingDevice.json().error.code, 'NOT_FOUND');

  const missingSchedule = await app.inject({
    method: 'PUT',
    url: `/api/v1/devices/${deviceId}/schedules/${missingScheduleId}`,
    payload: validSchedule,
  });
  assert.equal(missingSchedule.statusCode, 404);
  assert.equal(missingSchedule.json().error.code, 'NOT_FOUND');
});

test('schedule sync returns a full snapshot with tombstones', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const first = await app.inject({
    method: 'POST', url: `/api/v1/devices/${deviceId}/schedules`, payload: validSchedule,
  });
  const firstId = first.json().schedule_id;
  const second = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/schedules`,
    payload: { ...validSchedule, time_local: '19:30:00' },
  });
  const secondId = second.json().schedule_id;
  await app.inject({
    method: 'DELETE', url: `/api/v1/devices/${deviceId}/schedules/${firstId}`,
  });

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${deviceId}/sync/schedules?known_revision=3`,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().schedule_revision, 3);
  assert.equal(response.json().generated_at, '2026-10-29T02:15:00.000Z');
  assert.equal(response.json().items.length, 2);
  assert.equal(
    response.json().items.find((item: { schedule_id: string }) => item.schedule_id === firstId).deleted_at,
    '2026-10-29T02:10:00.000Z',
  );
  assert.equal(
    response.json().items.find((item: { schedule_id: string }) => item.schedule_id === secondId).deleted_at,
    null,
  );
});

test('schedule sync validates known_revision and returns not found for an unknown device', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  for (const query of ['', '?known_revision=-1', '?known_revision=1.5', '?known_revision=unknown', '?known_revision=1&extra=1']) {
    const response = await app.inject({
      method: 'GET', url: `/api/v1/devices/${deviceId}/sync/schedules${query}`,
    });
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }

  const missing = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${missingDeviceId}/sync/schedules?known_revision=0`,
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'NOT_FOUND');
});

function record(scheduleId: string, values: ScheduleValues, revision: number): ScheduleRecord {
  return {
    scheduleId,
    deviceId,
    ...recordValues(values),
    revision: String(revision),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function recordValues(values: ScheduleValues) {
  return {
    timeLocal: values.timeLocal,
    daysOfWeek: values.daysOfWeek,
    timezone: values.timezone,
    portionGrams: values.portionGrams.toFixed(2),
    active: values.active,
  };
}

