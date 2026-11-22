import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import type { DeviceAuthenticationRepository } from '../src/authentication/device-authentication.repository.js';
import { createDeviceAuthenticator } from '../src/authentication/device-authentication.service.js';
import type { CommandRepository } from '../src/commands/command.repository.js';
import type { DeviceRepository } from '../src/devices/device.repository.js';
import type { FeedingRepository } from '../src/feedings/feeding.repository.js';
import type { ScheduleRepository } from '../src/schedules/schedule.repository.js';
import { trustedUserAuthenticator } from './support/user-authenticator.js';

const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const commandId = '1875723f-f6e1-4307-92c8-81577f1ea2fb';
const feedingId = '693df286-f089-463e-848d-5a19f7027449';

const commandRepository: CommandRepository = {
  async create() { throw new Error('Command repository must not be called'); },
  async listPending() { throw new Error('Command repository must not be called'); },
  async acknowledge() { throw new Error('Command repository must not be called'); },
  async submitResult() { throw new Error('Command repository must not be called'); },
};
const deviceRepository: DeviceRepository = {
  async findState() { return null; },
  async updateStateIfNewer() { throw new Error('Device repository must not be called'); },
};
const feedingRepository: FeedingRepository = {
  async createScheduledEvent() { throw new Error('Feeding repository must not be called'); },
  async find() { throw new Error('Feeding repository must not be called'); },
  async list() { throw new Error('Feeding repository must not be called'); },
};
const scheduleRepository: ScheduleRepository = {
  async list() { throw new Error('Schedule repository must not be called'); },
  async sync() { throw new Error('Schedule repository must not be called'); },
  async create() { throw new Error('Schedule repository must not be called'); },
  async update() { throw new Error('Schedule repository must not be called'); },
  async delete() { throw new Error('Schedule repository must not be called'); },
};

test('all Khadas routes reject requests without device credentials before validation', async (t) => {
  const app = await buildApp({
    checkDatabase: async () => undefined,
    commandRepository,
    deviceRepository,
    feedingRepository,
    scheduleRepository,
    userAuthenticator: trustedUserAuthenticator,
  });
  t.after(() => app.close());

  const routes = [
    { method: 'PUT', url: `/api/v1/devices/${deviceId}/state` },
    { method: 'GET', url: `/api/v1/devices/${deviceId}/sync/schedules` },
    { method: 'GET', url: `/api/v1/devices/${deviceId}/commands/pending` },
    { method: 'POST', url: `/api/v1/devices/${deviceId}/commands/${commandId}/ack` },
    { method: 'POST', url: `/api/v1/devices/${deviceId}/feedings/${feedingId}/result` },
    { method: 'POST', url: `/api/v1/devices/${deviceId}/feeding-events` },
  ] as const;

  for (const route of routes) {
    const response = await app.inject(route);
    assert.equal(response.statusCode, 401, `${route.method} ${route.url}`);
    assert.equal(response.headers['www-authenticate'], 'Bearer');
    assert.equal(response.json().error.code, 'UNAUTHORIZED');
  }
});

test('Android read route is not protected by device credentials', async (t) => {
  const app = await buildApp({
    checkDatabase: async () => undefined,
    commandRepository,
    deviceRepository,
    feedingRepository,
    scheduleRepository,
    userAuthenticator: trustedUserAuthenticator,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${deviceId}/state`,
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'NOT_FOUND');
});

test('an active token of another device returns forbidden', async (t) => {
  const deviceToken = `dvc_${Buffer.alloc(32, 9).toString('base64url')}`;
  const authenticationRepository: DeviceAuthenticationRepository = {
    async findActiveByTokenHash() {
      return {
        credentialId: '36ee8225-cd00-46ea-b6ef-db9e66b0946b',
        deviceId: '4d6b9594-9278-4621-88f3-876b3d127fd8',
      };
    },
    async markUsedIfActive() {
      throw new Error('A credential of another device must not be marked as used');
    },
  };
  const app = await buildApp({
    checkDatabase: async () => undefined,
    commandRepository,
    deviceAuthenticator: createDeviceAuthenticator(authenticationRepository),
    deviceRepository,
    feedingRepository,
    scheduleRepository,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${deviceId}/commands/pending`,
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.headers['www-authenticate'], undefined);
  assert.equal(response.json().error.code, 'FORBIDDEN');
});

test('a valid-format revoked token returns unauthorized', async (t) => {
  const deviceToken = `dvc_${Buffer.alloc(32, 10).toString('base64url')}`;
  const authenticationRepository: DeviceAuthenticationRepository = {
    async findActiveByTokenHash() { return null; },
    async markUsedIfActive() { throw new Error('A revoked credential must not be marked as used'); },
  };
  const app = await buildApp({
    checkDatabase: async () => undefined,
    commandRepository,
    deviceAuthenticator: createDeviceAuthenticator(authenticationRepository),
    deviceRepository,
    feedingRepository,
    scheduleRepository,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${deviceId}/commands/pending`,
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers['www-authenticate'], 'Bearer');
  assert.equal(response.json().error.code, 'UNAUTHORIZED');
});
