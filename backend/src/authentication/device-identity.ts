import 'fastify';

import type { DeviceCredentialIdentity } from './device-authentication.repository.js';

declare module 'fastify' {
  interface FastifyRequest {
    deviceIdentity: DeviceCredentialIdentity | null;
  }
}

interface DeviceIdentityRequest {
  deviceIdentity: DeviceCredentialIdentity | null;
}

export function setDeviceIdentity(
  request: DeviceIdentityRequest,
  identity: DeviceCredentialIdentity,
): void {
  request.deviceIdentity = identity;
}

export function getDeviceIdentity(request: DeviceIdentityRequest): DeviceCredentialIdentity {
  if (!request.deviceIdentity) throw new Error('Authenticated device identity is missing');
  return request.deviceIdentity;
}
