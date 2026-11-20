import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type {
  DeviceAuthenticationRepository,
  DeviceCredentialIdentity,
} from '../src/authentication/device-authentication.repository.js';
import { createDeviceAuthenticator } from '../src/authentication/device-authentication.service.js';
import { ForbiddenError, UnauthorizedError } from '../src/utils/http-error.js';

const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const otherDeviceId = '4d6b9594-9278-4621-88f3-876b3d127fd8';
const credentialId = '1875723f-f6e1-4307-92c8-81577f1ea2fb';
const deviceToken = `dvc_${Buffer.alloc(32, 7).toString('base64url')}`;
const tokenHash = createHash('sha256').update(deviceToken, 'utf8').digest();

function repository(identity: DeviceCredentialIdentity | null, active = true):
DeviceAuthenticationRepository & { hashes: Buffer[]; marked: string[] } {
  const hashes: Buffer[] = [];
  const marked: string[] = [];
  return {
    hashes,
    marked,
    async findActiveByTokenHash(hash) {
      hashes.push(hash);
      return hash.equals(tokenHash) ? identity : null;
    },
    async markUsedIfActive(id) {
      marked.push(id);
      return active;
    },
  };
}

test('device authentication accepts an active token of the requested device', async () => {
  const storage = repository({ credentialId, deviceId });
  const authenticator = createDeviceAuthenticator(storage);

  const identity = await authenticator.authenticate(`Bearer ${deviceToken}`, deviceId);

  assert.deepEqual(identity, { credentialId, deviceId });
  assert.deepEqual(storage.hashes, [tokenHash]);
  assert.deepEqual(storage.marked, [credentialId]);

  const lowerCaseScheme = await authenticator.authenticate(`bearer ${deviceToken}`, deviceId);
  assert.deepEqual(lowerCaseScheme, { credentialId, deviceId });
});

test('missing, malformed, unknown, and revoked tokens are unauthorized', async () => {
  const authenticator = createDeviceAuthenticator(repository(null));
  for (const authorization of [
    undefined,
    '',
    'Basic credentials',
    'Bearer invalid',
    `Bearer ${deviceToken.replace('dvc_', 'DVC_')}`,
    `Bearer ${deviceToken.slice(0, -1)}`,
    `Bearer ${deviceToken}`,
  ]) {
    await assert.rejects(
      authenticator.authenticate(authorization, deviceId),
      UnauthorizedError,
    );
  }
});

test('a valid token cannot access another device identity', async () => {
  const storage = repository({ credentialId, deviceId });
  const authenticator = createDeviceAuthenticator(storage);

  await assert.rejects(
    authenticator.authenticate(`Bearer ${deviceToken}`, otherDeviceId),
    ForbiddenError,
  );
  assert.deepEqual(storage.marked, []);
});

test('revocation during authentication is unauthorized', async () => {
  const storage = repository({ credentialId, deviceId }, false);
  const authenticator = createDeviceAuthenticator(storage);

  await assert.rejects(
    authenticator.authenticate(`Bearer ${deviceToken}`, deviceId),
    UnauthorizedError,
  );
  assert.deepEqual(storage.marked, [credentialId]);
});
