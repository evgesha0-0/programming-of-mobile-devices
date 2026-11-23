import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import type { UserAuthenticationRepository } from '../src/authentication/user-authentication.repository.js';
import { createUserAuthenticator, type UserAuthenticator } from '../src/authentication/user-authentication.service.js';
import type { CommandRepository } from '../src/commands/command.repository.js';
import type { DeviceRepository } from '../src/devices/device.repository.js';
import type { FeedingRepository } from '../src/feedings/feeding.repository.js';
import type { ScheduleRepository } from '../src/schedules/schedule.repository.js';

const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const otherDeviceId = '4d6b9594-9278-4621-88f3-876b3d127fd8';
const scheduleId = '36ee8225-cd00-46ea-b6ef-db9e66b0946b';
const feedingId = '693df286-f089-463e-848d-5a19f7027449';

const commandRepository: CommandRepository = {
  async create() { throw new Error('Command repository must not be called'); },
  async listPending() { throw new Error('Command repository must not be called'); },
  async acknowledge() { throw new Error('Command repository must not be called'); },
  async submitResult() { throw new Error('Command repository must not be called'); },
};
const deviceRepository: DeviceRepository = {
  async findState() { throw new Error('Device repository must not be called'); },
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

async function appWith(userAuthenticator?: UserAuthenticator) {
  return buildApp({
    checkDatabase: async () => undefined,
    commandRepository,
    deviceRepository,
    feedingRepository,
    scheduleRepository,
    ...(userAuthenticator ? { userAuthenticator } : {}),
  });
}

test('all Android routes reject requests without user credentials before validation', async (t) => {
  const app = await appWith();
  t.after(() => app.close());
  const routes = [
    { method: 'GET', url: `/api/v1/devices/${deviceId}/state` },
    { method: 'GET', url: `/api/v1/devices/${deviceId}/schedules` },
    { method: 'POST', url: `/api/v1/devices/${deviceId}/schedules` },
    { method: 'PUT', url: `/api/v1/devices/${deviceId}/schedules/${scheduleId}` },
    { method: 'DELETE', url: `/api/v1/devices/${deviceId}/schedules/${scheduleId}` },
    { method: 'POST', url: `/api/v1/devices/${deviceId}/feeding-commands` },
    { method: 'GET', url: `/api/v1/devices/${deviceId}/feedings` },
    { method: 'GET', url: `/api/v1/devices/${deviceId}/feedings/${feedingId}` },
  ] as const;

  for (const route of routes) {
    const response = await app.inject(route);
    assert.equal(response.statusCode, 401, `${route.method} ${route.url}`);
    assert.equal(response.headers['www-authenticate'], 'Bearer');
    assert.equal(response.json().error.code, 'UNAUTHORIZED');
  }
});

test('viewer cannot execute owner operation', async (t) => {
  const app = await appWith(authenticatorFor('viewer', deviceId));
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/schedules`,
    headers: { authorization: `Bearer usr_${'a'.repeat(43)}` },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'FORBIDDEN');
});

test('user cannot read feeding data of another device', async (t) => {
  const app = await appWith(authenticatorFor('owner', deviceId));
  t.after(() => app.close());
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${otherDeviceId}/feedings/${feedingId}`,
    headers: { authorization: `Bearer usr_${'a'.repeat(43)}` },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'FORBIDDEN');
});

function authenticatorFor(role: 'owner' | 'viewer', accessibleDeviceId: string): UserAuthenticator {
  const repository: UserAuthenticationRepository = {
    async authenticateToken() {
      return {
        credentialId: '723fb100-1524-44e4-8b0a-b91fc6eb0964',
        userId: 'fcba4f1c-7cf2-43de-b60f-97be27b5b7dc',
      };
    },
    async findActiveAccess(userId, requestedDeviceId) {
      return requestedDeviceId === accessibleDeviceId
        ? {
            userId,
            deviceId: requestedDeviceId,
            role,
          }
        : null;
    },
  };
  return createUserAuthenticator(repository);
}
