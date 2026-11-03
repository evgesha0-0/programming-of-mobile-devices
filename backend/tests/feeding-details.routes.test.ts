import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommandRepository } from '../src/commands/command.repository.js';
import type { DeviceRepository } from '../src/devices/device.repository.js';
import type { FeedingRepository } from '../src/feedings/feeding.repository.js';
import type { FeedingDetailsRecord } from '../src/feedings/feeding.types.js';
import type { ScheduleRepository } from '../src/schedules/schedule.repository.js';

const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const feedingId = '1875723f-f6e1-4307-92c8-81577f1ea2fb';
const commandId = '8ff974de-b9f6-4844-b505-6817f7018a0b';

const unusedCommandRepository: CommandRepository = {
  async create() { throw new Error('Command repository must not be used by feeding details'); },
  async listPending() { throw new Error('Command repository must not be used by feeding details'); },
  async acknowledge() { throw new Error('Command repository must not be used by feeding details'); },
  async submitResult() { throw new Error('Command repository must not be used by feeding details'); },
};
const unusedDeviceRepository: DeviceRepository = {
  async findState() { throw new Error('Device repository must not be used by feeding details'); },
  async updateStateIfNewer() { throw new Error('Device repository must not be used by feeding details'); },
};
const unusedScheduleRepository: ScheduleRepository = {
  async list() { throw new Error('Schedule repository must not be used by feeding details'); },
  async sync() { throw new Error('Schedule repository must not be used by feeding details'); },
  async create() { throw new Error('Schedule repository must not be used by feeding details'); },
  async update() { throw new Error('Schedule repository must not be used by feeding details'); },
  async delete() { throw new Error('Schedule repository must not be used by feeding details'); },
};

const feeding: FeedingDetailsRecord = {
  feedingId,
  deviceId,
  scheduleId: null,
  commandId,
  source: 'manual',
  portionGrams: '40.00',
  actualGrams: null,
  status: 'failed',
  createdAt: new Date('2026-11-03T06:00:00Z'),
  startedAt: new Date('2026-11-03T06:00:05Z'),
  finishedAt: new Date('2026-11-03T06:00:10Z'),
  errorCode: 'MOTOR_ERROR',
  errorMessage: 'Motor is blocked',
};

function memoryRepository(): FeedingRepository {
  return {
    async createScheduledEvent() {
      throw new Error('Scheduled events must not be used by feeding details');
    },
    async find(requestDeviceId, requestFeedingId) {
      return requestDeviceId === deviceId && requestFeedingId === feedingId
        ? feeding
        : null;
    },
    async list() { throw new Error('Feeding history must not be used by feeding details'); },
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

test('feeding details returns the complete feeding representation', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${deviceId}/feedings/${feedingId}`,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    feeding_id: feedingId,
    device_id: deviceId,
    schedule_id: null,
    command_id: commandId,
    source: 'manual',
    portion_grams: 40,
    actual_grams: null,
    status: 'failed',
    created_at: '2026-11-03T06:00:00.000Z',
    started_at: '2026-11-03T06:00:05.000Z',
    finished_at: '2026-11-03T06:00:10.000Z',
    error_code: 'MOTOR_ERROR',
    error_message: 'Motor is blocked',
  });
});

test('feeding details does not expose a feeding through another device', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/4d6b9594-9278-4621-88f3-876b3d127fd8/feedings/${feedingId}`,
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'NOT_FOUND');
});

test('feeding details returns 404 for an unknown feeding', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${deviceId}/feedings/7e82b4d7-951a-4384-b684-f2e5b07c7d42`,
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'NOT_FOUND');
});

test('feeding details validates both path identifiers', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  for (const url of [
    `/api/v1/devices/not-a-uuid/feedings/${feedingId}`,
    `/api/v1/devices/${deviceId}/feedings/not-a-uuid`,
  ]) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }
});
