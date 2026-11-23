import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { UserAuthenticationRepository } from '../src/authentication/user-authentication.repository.js';
import { createUserAuthenticator } from '../src/authentication/user-authentication.service.js';
import { HttpError } from '../src/utils/http-error.js';

const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const otherDeviceId = '4d6b9594-9278-4621-88f3-876b3d127fd8';
const userId = 'fcba4f1c-7cf2-43de-b60f-97be27b5b7dc';
const credentialId = '723fb100-1524-44e4-8b0a-b91fc6eb0964';
const userToken = `usr_${'a'.repeat(43)}`;

function repository(role: 'owner' | 'viewer' | null):
UserAuthenticationRepository & { hashes: Buffer[]; requests: Array<[string, string]> } {
  const hashes: Buffer[] = [];
  const requests: Array<[string, string]> = [];
  return {
    hashes,
    requests,
    async authenticateToken(hash) {
      hashes.push(hash);
      return { credentialId, userId };
    },
    async findActiveAccess(requestedUserId, requestedDeviceId) {
      requests.push([requestedUserId, requestedDeviceId]);
      if (!role || requestedDeviceId !== deviceId) return null;
      return { userId: requestedUserId, deviceId, role };
    },
  };
}

test('owner token authenticates and returns database identity', async () => {
  const accessRepository = repository('owner');
  const authenticator = createUserAuthenticator(accessRepository);

  assert.deepEqual(await authenticator.authenticate(`Bearer ${userToken}`, deviceId, 'owner'), {
    credentialId,
    userId,
    deviceId,
    role: 'owner',
  });
  assert.deepEqual(
    accessRepository.hashes[0],
    createHash('sha256').update(userToken, 'utf8').digest(),
  );
  assert.deepEqual(accessRepository.requests, [[userId, deviceId]]);
});

test('missing and malformed user tokens return unauthorized', async () => {
  const authenticator = createUserAuthenticator(repository('owner'));
  for (const authorization of [
    undefined,
    '',
    'Basic value',
    'Bearer',
    'Bearer one two',
    'Bearer signed.jwt.token',
    `Bearer dvc_${'a'.repeat(43)}`,
  ]) {
    await rejectsWithStatus(authenticator.authenticate(authorization, deviceId, 'viewer'), 401);
  }
});

test('unknown or revoked user token returns unauthorized', async () => {
  const accessRepository = repository('owner');
  accessRepository.authenticateToken = async () => null;
  const authenticator = createUserAuthenticator(accessRepository);
  await rejectsWithStatus(
    authenticator.authenticate(`Bearer ${userToken}`, deviceId, 'viewer'),
    401,
  );
  assert.deepEqual(accessRepository.requests, []);
});

test('viewer can read but cannot mutate device resources', async () => {
  const authenticator = createUserAuthenticator(repository('viewer'));
  assert.equal(
    (await authenticator.authenticate(`Bearer ${userToken}`, deviceId, 'viewer')).role,
    'viewer',
  );
  await rejectsWithStatus(
    authenticator.authenticate(`Bearer ${userToken}`, deviceId, 'owner'),
    403,
  );
});

test('valid token without membership cannot access another device', async () => {
  const accessRepository = repository('owner');
  const authenticator = createUserAuthenticator(accessRepository);
  await rejectsWithStatus(
    authenticator.authenticate(`Bearer ${userToken}`, otherDeviceId, 'viewer'),
    403,
  );
  assert.equal(accessRepository.requests[0]?.[1], otherDeviceId);
});

async function rejectsWithStatus(promise: Promise<unknown>, statusCode: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => (
    error instanceof HttpError && error.statusCode === statusCode
  ));
}
