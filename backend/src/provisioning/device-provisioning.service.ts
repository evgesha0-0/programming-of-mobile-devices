import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type {
  DeviceCredentialValues,
  DeviceProvisioningRepository,
} from './device-provisioning.repository.js';

const DEVICE_TOKEN_SECRET_BYTES = 32;
const UUID_PATTERN = new RegExp(
  '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  'i',
);

export interface IssuedDeviceCredential {
  deviceId: string;
  deviceToken: string;
}

export interface RevokedDeviceCredential {
  deviceId: string;
  revoked: boolean;
}

export interface DeviceProvisioningService {
  provisionDevice(name: string): Promise<IssuedDeviceCredential>;
  rotateDeviceToken(deviceId: string): Promise<IssuedDeviceCredential>;
  revokeDeviceToken(deviceId: string): Promise<RevokedDeviceCredential>;
}

export interface DeviceProvisioningRandom {
  uuid(): string;
  bytes(size: number): Buffer;
}

export class ProvisioningValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ProvisioningDeviceNotFoundError extends Error {
  constructor(deviceId: string) {
    super(`Device ${deviceId} was not found`);
    this.name = new.target.name;
  }
}

export function createDeviceProvisioningService(
  repository: DeviceProvisioningRepository,
  random: DeviceProvisioningRandom = {
    uuid: () => randomUUID(),
    bytes: (size) => randomBytes(size),
  },
): DeviceProvisioningService {
  return {
    async provisionDevice(name) {
      const normalizedName = normalizeName(name);
      const deviceId = random.uuid();
      const issued = issueCredential(random);

      await repository.createDevice({
        deviceId,
        name: normalizedName,
        credential: issued.credential,
      });
      return { deviceId, deviceToken: issued.deviceToken };
    },

    async rotateDeviceToken(deviceId) {
      validateDeviceId(deviceId);
      const issued = issueCredential(random);
      if (!await repository.rotateCredential(deviceId, issued.credential)) {
        throw new ProvisioningDeviceNotFoundError(deviceId);
      }
      return { deviceId, deviceToken: issued.deviceToken };
    },

    async revokeDeviceToken(deviceId) {
      validateDeviceId(deviceId);
      const result = await repository.revokeCredential(deviceId);
      if (result === 'device_not_found') throw new ProvisioningDeviceNotFoundError(deviceId);
      return { deviceId, revoked: result === 'revoked' };
    },
  };
}

function issueCredential(random: DeviceProvisioningRandom): {
  deviceToken: string;
  credential: DeviceCredentialValues;
} {
  const secret = random.bytes(DEVICE_TOKEN_SECRET_BYTES);
  if (secret.length !== DEVICE_TOKEN_SECRET_BYTES) {
    throw new Error('Credential generator returned an invalid secret length');
  }

  const deviceToken = `dvc_${secret.toString('base64url')}`;
  const tokenHash = createHash('sha256').update(deviceToken, 'utf8').digest();
  return {
    deviceToken,
    credential: {
      credentialId: random.uuid(),
      tokenHash,
      tokenHint: tokenHash.subarray(0, 6).toString('hex'),
    },
  };
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (normalized.length < 1 || normalized.length > 100) {
    throw new ProvisioningValidationError('Device name must contain from 1 to 100 characters');
  }
  return normalized;
}

function validateDeviceId(deviceId: string): void {
  if (!UUID_PATTERN.test(deviceId)) {
    throw new ProvisioningValidationError('Device ID must be a UUID');
  }
}
