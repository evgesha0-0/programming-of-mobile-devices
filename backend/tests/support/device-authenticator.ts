import type { DeviceAuthenticator } from '../../src/authentication/device-authentication.service.js';

export const trustedDeviceAuthenticator: DeviceAuthenticator = {
  async authenticate(_authorization, requestedDeviceId) {
    return {
      credentialId: '1875723f-f6e1-4307-92c8-81577f1ea2fb',
      deviceId: requestedDeviceId,
    };
  },
};
