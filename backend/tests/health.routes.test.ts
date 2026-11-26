import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommandRepository } from '../src/commands/command.repository.js';
import type { DeviceRepository } from '../src/devices/device.repository.js';
import type { FeedingRepository } from '../src/feedings/feeding.repository.js';
import type { ScheduleRepository } from '../src/schedules/schedule.repository.js';

const unusedDeviceRepository: DeviceRepository = {
  async findState() {
    throw new Error('Device repository must not be used by health routes');
  },
  async updateStateIfNewer() {
    throw new Error('Device repository must not be used by health routes');
  },
};

const unusedCommandRepository: CommandRepository = {
  async create() { throw new Error('Command repository must not be used by health routes'); },
  async listPending() { throw new Error('Command repository must not be used by health routes'); },
  async acknowledge() { throw new Error('Command repository must not be used by health routes'); },
  async submitResult() { throw new Error('Command repository must not be used by health routes'); },
};

const unusedScheduleRepository: ScheduleRepository = {
  async list() { throw new Error('Schedule repository must not be used by health routes'); },
  async sync() { throw new Error('Schedule repository must not be used by health routes'); },
  async create() { throw new Error('Schedule repository must not be used by health routes'); },
  async update() { throw new Error('Schedule repository must not be used by health routes'); },
  async delete() { throw new Error('Schedule repository must not be used by health routes'); },
};

const unusedFeedingRepository: FeedingRepository = {
  async createScheduledEvent() { throw new Error('Feeding repository must not be used by health routes'); },
  async find() { throw new Error('Feeding repository must not be used by health routes'); },
  async list() { throw new Error('Feeding repository must not be used by health routes'); },
};

test('Fastify application initializes without opening a network port', async (t) => {
  const app = await buildApp({
    checkDatabase: async () => undefined,
    commandRepository: unusedCommandRepository,
    deviceRepository: unusedDeviceRepository,
    feedingRepository: unusedFeedingRepository,
    scheduleRepository: unusedScheduleRepository,
  });
  t.after(() => app.close());

  await app.ready();

  assert.equal(app.server.listening, false);
});

test('Swagger generates the device API and separates Android and Khadas tokens', async (t) => {
  const app = await buildApp({
    checkDatabase: async () => undefined,
    commandRepository: unusedCommandRepository,
    deviceRepository: unusedDeviceRepository,
    feedingRepository: unusedFeedingRepository,
    scheduleRepository: unusedScheduleRepository,
  });
  t.after(() => app.close());

  const ui = await app.inject('/docs/');
  assert.equal(ui.statusCode, 200);
  const response = await app.inject('/docs/json');
  assert.equal(response.statusCode, 200);
  const document = response.json();
  const state = document.paths['/api/v1/devices/{device_id}/state'];
  assert.deepEqual(state.get.security, [{ userToken: [] }]);
  assert.deepEqual(state.put.security, [{ deviceToken: [] }]);
  const devicePaths = Object.entries(document.paths as Record<string, object>)
    .filter(([path]) => path.startsWith('/api/v1/devices/'));
  const methods = new Set(['get', 'post', 'put', 'delete']);
  assert.equal(devicePaths.flatMap(([, operations]) =>
    Object.keys(operations).filter((method) => methods.has(method))).length, 14);
});

test('GET /health reports that HTTP server is alive without checking PostgreSQL', async (t) => {
  let databaseChecks = 0;
  const app = await buildApp({
    checkDatabase: async () => {
      databaseChecks += 1;
    },
    commandRepository: unusedCommandRepository,
    deviceRepository: unusedDeviceRepository,
    feedingRepository: unusedFeedingRepository,
    scheduleRepository: unusedScheduleRepository,
  });
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: 'ok',
    service: 'smart-cat-feeder-backend',
  });
  assert.equal(databaseChecks, 0);
});

test('GET /ready reports connected PostgreSQL', async (t) => {
  const app = await buildApp({
    checkDatabase: async () => undefined,
    commandRepository: unusedCommandRepository,
    deviceRepository: unusedDeviceRepository,
    feedingRepository: unusedFeedingRepository,
    scheduleRepository: unusedScheduleRepository,
  });
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/ready' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: 'ready',
    database: 'connected',
  });
});

test('GET /ready returns 503 without exposing PostgreSQL error', async (t) => {
  const app = await buildApp({
    checkDatabase: async () => {
      throw new Error('postgresql-secret-error');
    },
    commandRepository: unusedCommandRepository,
    deviceRepository: unusedDeviceRepository,
    feedingRepository: unusedFeedingRepository,
    scheduleRepository: unusedScheduleRepository,
  });
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/ready' });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    status: 'not_ready',
    database: 'disconnected',
  });
  assert.equal(response.body.includes('postgresql-secret-error'), false);
});
