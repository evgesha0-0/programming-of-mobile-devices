import type { UserAuthenticator } from '../../src/authentication/user-authentication.service.js';

export const trustedUserAuthenticator: UserAuthenticator = {
  async authenticate(_authorization, requestedDeviceId, requiredRole) {
    return {
      userId: 'fcba4f1c-7cf2-43de-b60f-97be27b5b7dc',
      deviceId: requestedDeviceId,
      role: requiredRole,
      credentialId: '723fb100-1524-44e4-8b0a-b91fc6eb0964',
    };
  },
};
