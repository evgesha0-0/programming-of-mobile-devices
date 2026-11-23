import { createHash } from 'node:crypto';

import type {
  UserAuthenticationRepository,
  UserDeviceAccess,
  UserDeviceRole,
} from './user-authentication.repository.js';
import { ForbiddenError, UnauthorizedError } from '../utils/http-error.js';

const USER_TOKEN_PATTERN = /^[Bb][Ee][Aa][Rr][Ee][Rr][ \t]+(usr_[A-Za-z0-9_-]{43})$/;

export interface AuthenticatedUser extends UserDeviceAccess {
  credentialId: string;
}

export interface UserAuthenticator {
  authenticate(
    authorization: string | undefined,
    requestedDeviceId: string,
    requiredRole: UserDeviceRole,
  ): Promise<AuthenticatedUser>;
}

export const rejectingUserAuthenticator: UserAuthenticator = {
  async authenticate() {
    throw new UnauthorizedError('Invalid user credentials');
  },
};

export function createUserAuthenticator(
  repository: UserAuthenticationRepository,
): UserAuthenticator {
  return {
    async authenticate(authorization, requestedDeviceId, requiredRole) {
      const userToken = authorization?.match(USER_TOKEN_PATTERN)?.[1];
      if (!userToken) throw new UnauthorizedError('Invalid user credentials');

      const tokenHash = createHash('sha256').update(userToken, 'utf8').digest();
      const credential = await repository.authenticateToken(tokenHash);
      if (!credential) throw new UnauthorizedError('Invalid user credentials');

      const access = await repository.findActiveAccess(credential.userId, requestedDeviceId);
      if (!access || (requiredRole === 'owner' && access.role !== 'owner')) {
        throw new ForbiddenError('User does not have access to the requested device');
      }
      return { ...access, credentialId: credential.credentialId };
    },
  };
}
