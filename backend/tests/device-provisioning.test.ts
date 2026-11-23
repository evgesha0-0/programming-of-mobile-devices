import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type {
  DeviceCredentialValues,
  DeviceProvisioningRepository,
  NewDeviceValues,
  RevokeDeviceCredentialResult,
} from '../src/provisioning/device-provisioning.repository.js';
import {
  createDeviceProvisioningService,
  ProvisioningDeviceNotFoundError,
  ProvisioningValidationError,
  type DeviceProvisioningRandom,
} from '../src/provisioning/device-provisioning.service.js';

const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const credentialId = '1875723f-f6e1-4307-92c8-81577f1ea2fb';
const rotatedCredentialId = '4d6b9594-9278-4621-88f3-876b3d127fd8';
const rejectedCredentialId = '693df286-f089-463e-848d-5a19f7027449';

function deterministicRandom(): DeviceProvisioningRandom {
  const uuids = [deviceId, credentialId, rotatedCredentialId, rejectedCredentialId];
  let secret = 0;
  return {
    uuid() {
      const value = uuids.shift();
      if (!value) throw new Error('No deterministic UUID left');
      return value;
    },
    bytes(size) {
      secret += 1;
      return Buffer.alloc(size, secret);
    },
  };
}

function repository(): DeviceProvisioningRepository & {
  created: NewDeviceValues[];
  rotated: Array<{ deviceId: string; credential: DeviceCredentialValues }>;
  revokeResult: RevokeDeviceCredentialResult;
} {
  const storage: DeviceProvisioningRepository & {
    created: NewDeviceValues[];
    rotated: Array<{ deviceId: string; credential: DeviceCredentialValues }>;
    revokeResult: RevokeDeviceCredentialResult;
  } = {
    created: [],
    rotated: [],
    revokeResult: 'revoked',
    async createDevice(values: NewDeviceValues) { storage.created.push(values); },
    async rotateCredential(id, credential) {
      storage.rotated.push({ deviceId: id, credential });
      return id === deviceId;
    },
    async revokeCredential(id) {
      return id === deviceId ? storage.revokeResult : 'device_not_found';
    },
  };
  return storage;
}

test('provisioning returns a token once and passes only its hash to the repository', async () => {
  const storage = repository();
  const service = createDeviceProvisioningService(storage, deterministicRandom());

  const result = await service.provisionDevice('  Кормушка на кухне  ');

  assert.equal(result.deviceId, deviceId);
  assert.match(result.deviceToken, /^dvc_[A-Za-z0-9_-]{43}$/);
  assert.equal(storage.created.length, 1);
  const stored = storage.created[0];
  assert.equal(stored?.deviceId, deviceId);
  assert.equal(stored?.name, 'Кормушка на кухне');
  assert.deepEqual(Object.keys(stored?.credential ?? {}).sort(), [
    'credentialId', 'tokenHash', 'tokenHint',
  ]);
  const expectedHash = createHash('sha256').update(result.deviceToken, 'utf8').digest();
  assert.deepEqual(stored?.credential.tokenHash, expectedHash);
  assert.equal(stored?.credential.tokenHint, expectedHash.subarray(0, 6).toString('hex'));
});

test('token rotation issues a new secret and rejects an unknown device', async () => {
  const storage = repository();
  const service = createDeviceProvisioningService(storage, deterministicRandom());
  const initial = await service.provisionDevice('Кормушка');

  const rotated = await service.rotateDeviceToken(deviceId);

  assert.notEqual(rotated.deviceToken, initial.deviceToken);
  assert.equal(storage.rotated[0]?.deviceId, deviceId);
  assert.equal(storage.rotated[0]?.credential.credentialId, rotatedCredentialId);
  await assert.rejects(
    service.rotateDeviceToken('693df286-f089-463e-848d-5a19f7027449'),
    ProvisioningDeviceNotFoundError,
  );
});

test('token revocation is idempotent and distinguishes a missing device', async () => {
  const storage = repository();
  const service = createDeviceProvisioningService(storage, deterministicRandom());

  assert.deepEqual(await service.revokeDeviceToken(deviceId), { deviceId, revoked: true });
  storage.revokeResult = 'already_revoked';
  assert.deepEqual(await service.revokeDeviceToken(deviceId), { deviceId, revoked: false });
  await assert.rejects(
    service.revokeDeviceToken('693df286-f089-463e-848d-5a19f7027449'),
    ProvisioningDeviceNotFoundError,
  );
});

test('provisioning validates device names and identifiers before accessing storage', async () => {
  const storage = repository();
  const service = createDeviceProvisioningService(storage, deterministicRandom());

  await assert.rejects(service.provisionDevice('   '), ProvisioningValidationError);
  await assert.rejects(service.provisionDevice('x'.repeat(101)), ProvisioningValidationError);
  await assert.rejects(service.rotateDeviceToken('not-a-uuid'), ProvisioningValidationError);
  await assert.rejects(service.revokeDeviceToken('not-a-uuid'), ProvisioningValidationError);
  assert.equal(storage.created.length, 0);
  assert.equal(storage.rotated.length, 0);
});
