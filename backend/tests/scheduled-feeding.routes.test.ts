import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommandRepository } from '../src/commands/command.repository.js';
import type { DeviceRepository } from '../src/devices/device.repository.js';
import type { FeedingRepository } from '../src/feedings/feeding.repository.js';
import type {
  ScheduledFeedingEventRecord,
  ScheduledFeedingEventValues,
} from '../src/feedings/feeding.types.js';
import type { ScheduleRepository } from '../src/schedules/schedule.repository.js';

const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const scheduleId = 'ee681479-a7cf-4afb-b7a7-ddc70bb22120';
const feedingId = '1875723f-f6e1-4307-92c8-81577f1ea2fb';
const receivedAt = new Date('2026-11-03T06:00:00Z');

const unusedCommandRepository: CommandRepository = {
  async create() { throw new Error('Command repository must not be used by feeding routes'); },
  async listPending() { throw new Error('Command repository must not be used by feeding routes'); },
  async acknowledge() { throw new Error('Command repository must not be used by feeding routes'); },
  async submitResult() { throw new Error('Command repository must not be used by feeding routes'); },
};
const unusedDeviceRepository: DeviceRepository = {
  async findState() { throw new Error('Device repository must not be used by feeding routes'); },
  async updateStateIfNewer() { throw new Error('Device repository must not be used by feeding routes'); },
};
const unusedScheduleRepository: ScheduleRepository = {
  async list() { throw new Error('Schedule repository must not be used by feeding routes'); },
  async sync() { throw new Error('Schedule repository must not be used by feeding routes'); },
  async create() { throw new Error('Schedule repository must not be used by feeding routes'); },
  async update() { throw new Error('Schedule repository must not be used by feeding routes'); },
  async delete() { throw new Error('Schedule repository must not be used by feeding routes'); },
};

function memoryRepository(): FeedingRepository {
  const events = new Map<string, {
    values: ScheduledFeedingEventValues;
    event: ScheduledFeedingEventRecord;
  }>();

  return {
    async createScheduledEvent(values) {
      if (values.deviceId !== deviceId || values.scheduleId !== scheduleId) {
        return { kind: 'not_found' };
      }
      const existing = events.get(values.feedingId);
      if (existing) {
        return sameEvent(existing.values, values)
          ? { kind: 'repeated', event: existing.event }
          : { kind: 'conflict' };
      }
      if (values.startedAt < values.createdAt || values.finishedAt < values.startedAt) {
        return { kind: 'invalid_timeline' };
      }
      const event: ScheduledFeedingEventRecord = {
        feedingId: values.feedingId,
        deviceId: values.deviceId,
        scheduleId: values.scheduleId,
        source: 'scheduled',
        status: values.status,
        actualGrams: values.actualGrams === null ? null : values.actualGrams.toFixed(2),
        receivedAt,
      };
      events.set(values.feedingId, { values, event });
      return { kind: 'created', event };
    },
  };
}

async function appWith(feedingRepository = memoryRepository()) {
  return buildApp({
    checkDatabase: async () => undefined,
    commandRepository: unusedCommandRepository,
    deviceRepository: unusedDeviceRepository,
    feedingRepository,
    scheduleRepository: unusedScheduleRepository,
  });
}

const completedEvent = {
  feeding_id: feedingId,
  schedule_id: scheduleId,
  source: 'scheduled',
  portion_grams: 40,
  actual_grams: 39.5,
  status: 'completed',
  created_at: '2026-11-03T05:59:00Z',
  started_at: '2026-11-03T06:00:00Z',
  finished_at: '2026-11-03T06:00:10Z',
  error_code: null,
  error_message: null,
};

test('scheduled feeding event is created once and an exact retry is idempotent', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const first = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-events`,
    payload: completedEvent,
  });
  assert.equal(first.statusCode, 201);
  assert.deepEqual(first.json(), {
    feeding_id: feedingId,
    device_id: deviceId,
    schedule_id: scheduleId,
    source: 'scheduled',
    status: 'completed',
    actual_grams: 39.5,
    received_at: receivedAt.toISOString(),
  });

  const repeated = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-events`,
    payload: completedEvent,
  });
  assert.equal(repeated.statusCode, 200);
  assert.deepEqual(repeated.json(), first.json());

  const conflict = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-events`,
    payload: { ...completedEvent, actual_grams: 38 },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'CONFLICT');
});

test('failed scheduled feeding accepts a null actual weight and failure details', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-events`,
    payload: {
      ...completedEvent,
      actual_grams: null,
      status: 'failed',
      error_code: 'MOTOR_ERROR',
      error_message: 'Motor is blocked',
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().status, 'failed');
  assert.equal(response.json().actual_grams, null);
});

test('scheduled feeding rejects unknown resources and an invalid timeline', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const unknownDevice = await app.inject({
    method: 'POST',
    url: '/api/v1/devices/4d6b9594-9278-4621-88f3-876b3d127fd8/feeding-events',
    payload: completedEvent,
  });
  assert.equal(unknownDevice.statusCode, 404);

  const unknownSchedule = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-events`,
    payload: { ...completedEvent, schedule_id: '7e82b4d7-951a-4384-b684-f2e5b07c7d42' },
  });
  assert.equal(unknownSchedule.statusCode, 404);

  const invalidTimeline = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-events`,
    payload: { ...completedEvent, finished_at: '2026-11-03T05:59:59Z' },
  });
  assert.equal(invalidTimeline.statusCode, 400);
  assert.equal(invalidTimeline.json().error.code, 'VALIDATION_ERROR');
});

test('scheduled feeding request validates variants, precision and additional fields', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const invalidBodies = [
    { ...completedEvent, source: 'manual' },
    { ...completedEvent, actual_grams: null },
    { ...completedEvent, error_code: 'MOTOR_ERROR' },
    { ...completedEvent, portion_grams: 40.001 },
    { ...completedEvent, created_at: 'not-a-date' },
    { ...completedEvent, extra: true },
    {
      ...completedEvent,
      actual_grams: null,
      status: 'failed',
      error_code: '   ',
      error_message: 'Motor is blocked',
    },
  ];

  for (const payload of invalidBodies) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/feeding-events`,
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }
});

function sameEvent(
  left: ScheduledFeedingEventValues,
  right: ScheduledFeedingEventValues,
): boolean {
  return left.feedingId === right.feedingId
    && left.deviceId === right.deviceId
    && left.scheduleId === right.scheduleId
    && left.source === right.source
    && left.portionGrams === right.portionGrams
    && left.actualGrams === right.actualGrams
    && left.status === right.status
    && left.createdAt.getTime() === right.createdAt.getTime()
    && left.startedAt.getTime() === right.startedAt.getTime()
    && left.finishedAt.getTime() === right.finishedAt.getTime()
    && left.errorCode === right.errorCode
    && left.errorMessage === right.errorMessage;
}
