import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommandRepository } from '../src/commands/command.repository.js';
import type { DeviceRepository } from '../src/devices/device.repository.js';
import type { FeedingRepository } from '../src/feedings/feeding.repository.js';
import type { FeedingHistoryItemRecord } from '../src/feedings/feeding.types.js';
import type { ScheduleRepository } from '../src/schedules/schedule.repository.js';

const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const missingDeviceId = '4d6b9594-9278-4621-88f3-876b3d127fd8';

const unusedCommandRepository: CommandRepository = {
  async create() { throw new Error('Command repository must not be used by history routes'); },
  async listPending() { throw new Error('Command repository must not be used by history routes'); },
  async acknowledge() { throw new Error('Command repository must not be used by history routes'); },
  async submitResult() { throw new Error('Command repository must not be used by history routes'); },
};
const unusedDeviceRepository: DeviceRepository = {
  async findState() { throw new Error('Device repository must not be used by history routes'); },
  async updateStateIfNewer() { throw new Error('Device repository must not be used by history routes'); },
};
const unusedScheduleRepository: ScheduleRepository = {
  async list() { throw new Error('Schedule repository must not be used by history routes'); },
  async sync() { throw new Error('Schedule repository must not be used by history routes'); },
  async create() { throw new Error('Schedule repository must not be used by history routes'); },
  async update() { throw new Error('Schedule repository must not be used by history routes'); },
  async delete() { throw new Error('Schedule repository must not be used by history routes'); },
};

const items: FeedingHistoryItemRecord[] = [
  {
    feedingId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
    deviceId,
    scheduleId: null,
    commandId: '1875723f-f6e1-4307-92c8-81577f1ea2fb',
    source: 'manual',
    portionGrams: '40.00',
    actualGrams: null,
    status: 'running',
    createdAt: new Date('2026-11-03T06:00:00Z'),
    startedAt: new Date('2026-11-03T06:00:05Z'),
    finishedAt: null,
    errorCode: null,
  },
  {
    feedingId: 'eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee',
    deviceId,
    scheduleId: 'ee681479-a7cf-4afb-b7a7-ddc70bb22120',
    commandId: null,
    source: 'scheduled',
    portionGrams: '45.00',
    actualGrams: '44.70',
    status: 'completed',
    createdAt: new Date('2026-11-03T05:00:00Z'),
    startedAt: new Date('2026-11-03T05:00:01Z'),
    finishedAt: new Date('2026-11-03T05:00:12Z'),
    errorCode: null,
  },
];

function memoryRepository(): FeedingRepository {
  return {
    async createScheduledEvent() {
      throw new Error('Scheduled events must not be used by history tests');
    },
    async list(id, limit, cursor) {
      if (id !== deviceId) return null;
      const start = cursor === null
        ? 0
        : items.findIndex((item) => item.feedingId === cursor.feedingId) + 1;
      const page = items.slice(start, start + limit);
      const last = page.at(-1);
      return {
        items: page,
        nextCursor: start + page.length < items.length && last
          ? { createdAt: last.createdAt.toISOString(), feedingId: last.feedingId }
          : null,
      };
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

test('feeding history maps manual and scheduled records', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${deviceId}/feedings`,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    items: [
      {
        feeding_id: items[0]?.feedingId,
        device_id: deviceId,
        schedule_id: null,
        command_id: items[0]?.commandId,
        source: 'manual',
        portion_grams: 40,
        actual_grams: null,
        status: 'running',
        created_at: '2026-11-03T06:00:00.000Z',
        started_at: '2026-11-03T06:00:05.000Z',
        finished_at: null,
        error_code: null,
      },
      {
        feeding_id: items[1]?.feedingId,
        device_id: deviceId,
        schedule_id: items[1]?.scheduleId,
        command_id: null,
        source: 'scheduled',
        portion_grams: 45,
        actual_grams: 44.7,
        status: 'completed',
        created_at: '2026-11-03T05:00:00.000Z',
        started_at: '2026-11-03T05:00:01.000Z',
        finished_at: '2026-11-03T05:00:12.000Z',
        error_code: null,
      },
    ],
    next_cursor: null,
  });
});

test('feeding history cursor returns the next page without duplicates', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const first = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${deviceId}/feedings?limit=1`,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().items[0].feeding_id, items[0]?.feedingId);
  assert.equal(typeof first.json().next_cursor, 'string');

  const second = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${deviceId}/feedings?limit=1&cursor=${first.json().next_cursor}`,
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().items[0].feeding_id, items[1]?.feedingId);
  assert.equal(second.json().next_cursor, null);
});

test('feeding history returns 404 for an unknown device', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${missingDeviceId}/feedings`,
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'NOT_FOUND');
});

test('feeding history validates limit, cursor and query fields', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'cursor=invalid', 'other=1']) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceId}/feedings?${query}`,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }
});
