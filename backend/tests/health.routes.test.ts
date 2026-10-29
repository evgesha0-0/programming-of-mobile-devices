import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import type { DeviceRepository } from '../src/devices/device.repository.js';
import type { ScheduleRepository } from '../src/schedules/schedule.repository.js';

const unusedDeviceRepository: DeviceRepository = {
  async findState() {
    throw new Error('Device repository must not be used by health routes');
  },
  async updateStateIfNewer() {
    throw new Error('Device repository must not be used by health routes');
  },
};

const unusedScheduleRepository: ScheduleRepository = {
  async list() { throw new Error('Schedule repository must not be used by health routes'); },
  async sync() { throw new Error('Schedule repository must not be used by health routes'); },
  async create() { throw new Error('Schedule repository must not be used by health routes'); },
  async update() { throw new Error('Schedule repository must not be used by health routes'); },
  async delete() { throw new Error('Schedule repository must not be used by health routes'); },
};

test('Fastify application initializes without opening a network port', async (t) => {
  const app = await buildApp({
    checkDatabase: async () => undefined,
    deviceRepository: unusedDeviceRepository,
    scheduleRepository: unusedScheduleRepository,
  });
  t.after(() => app.close());

  await app.ready();

  assert.equal(app.server.listening, false);
});

test('GET /health reports that HTTP server is alive without checking PostgreSQL', async (t) => {
  let databaseChecks = 0;
  const app = await buildApp({
    checkDatabase: async () => {
      databaseChecks += 1;
    },
    deviceRepository: unusedDeviceRepository,
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
    deviceRepository: unusedDeviceRepository,
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
    deviceRepository: unusedDeviceRepository,
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
