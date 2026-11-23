import { createHash } from 'node:crypto';

import type {
  DeviceAuthenticationRepository,
  DeviceCredentialIdentity,
} from './device-authentication.repository.js';
import { ForbiddenError, UnauthorizedError } from '../utils/http-error.js';

const DEVICE_TOKEN_PATTERN = /^[Bb][Ee][Aa][Rr][Ee][Rr][ \t]+(dvc_[A-Za-z0-9_-]{43})$/;

export interface DeviceAuthenticator {
  authenticate(
    authorization: string | undefined,
    requestedDeviceId: string,
  ): Promise<DeviceCredentialIdentity>;
}

export const rejectingDeviceAuthenticator: DeviceAuthenticator = {
  async authenticate() {
    throw new UnauthorizedError('Invalid device credentials');
  },
};

export function createDeviceAuthenticator(
  repository: DeviceAuthenticationRepository,
): DeviceAuthenticator {
  return {
    async authenticate(authorization, requestedDeviceId) {
      const match = authorization?.match(DEVICE_TOKEN_PATTERN);
      const deviceToken = match?.[1];
      if (!deviceToken) throw new UnauthorizedError('Invalid device credentials');

      const tokenHash = createHash('sha256').update(deviceToken, 'utf8').digest();
      const identity = await repository.findActiveByTokenHash(tokenHash);
      if (!identity) throw new UnauthorizedError('Invalid device credentials');
      if (identity.deviceId !== requestedDeviceId) {
        throw new ForbiddenError('Device credentials do not belong to the requested device');
      }
      if (!await repository.markUsedIfActive(identity.credentialId)) {
        throw new UnauthorizedError('Invalid device credentials');
      }
      return identity;
    },
  };
}
