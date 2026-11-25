import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type {
  UserCredentialValues,
  UserProvisioningRepository,
} from './user-provisioning.repository.js';

const USER_TOKEN_SECRET_BYTES = 32;
const UUID_PATTERN = new RegExp(
  '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  'i',
);

export interface IssuedUserCredential {
  userId: string;
  userToken: string;
}

export interface IssuedUserOwnerCredential extends IssuedUserCredential {
  deviceId: string;
  role: 'owner';
}

export interface RevokedUserCredential {
  userId: string;
  revoked: boolean;
}

export interface UserProvisioningService {
  provisionOwner(deviceId: string): Promise<IssuedUserOwnerCredential>;
  rotateUserToken(userId: string): Promise<IssuedUserCredential>;
  revokeUserToken(userId: string): Promise<RevokedUserCredential>;
}

export interface UserProvisioningRandom {
  uuid(): string;
  bytes(size: number): Buffer;
}

export class UserProvisioningValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UserProvisioningDeviceNotFoundError extends Error {
  constructor(deviceId: string) {
    super(`Device ${deviceId} was not found`);
    this.name = new.target.name;
  }
}

export class UserProvisioningOwnerExistsError extends Error {
  constructor(deviceId: string) {
    super(`Device ${deviceId} already has an active owner`);
    this.name = new.target.name;
  }
}

export class UserProvisioningUserNotFoundError extends Error {
  constructor(userId: string) {
    super(`User ${userId} was not found`);
    this.name = new.target.name;
  }
}

export function createUserProvisioningService(
  repository: UserProvisioningRepository,
  random: UserProvisioningRandom = {
    uuid: () => randomUUID(),
    bytes: (size) => randomBytes(size),
  },
): UserProvisioningService {
  return {
    async provisionOwner(deviceId) {
      validateDeviceId(deviceId);
      const issued = issueCredential(random);
      const userId = random.uuid();
      const result = await repository.provisionOwner({
        userId,
        deviceId,
        userDeviceId: random.uuid(),
        credential: issued.credential,
      });
      if (result === 'device_not_found') {
        throw new UserProvisioningDeviceNotFoundError(deviceId);
      }
      if (result === 'owner_exists') {
        throw new UserProvisioningOwnerExistsError(deviceId);
      }
      return {
        userId,
        userToken: issued.userToken,
        deviceId,
        role: 'owner',
      };
    },

    async rotateUserToken(userId) {
      validateUserId(userId);
      const issued = issueCredential(random);
      if (!await repository.rotateCredential(userId, issued.credential)) {
        throw new UserProvisioningUserNotFoundError(userId);
      }
      return { userId, userToken: issued.userToken };
    },

    async revokeUserToken(userId) {
      validateUserId(userId);
      const result = await repository.revokeCredential(userId);
      if (result === 'user_not_found') {
        throw new UserProvisioningUserNotFoundError(userId);
      }
      return { userId, revoked: result === 'revoked' };
    },
  };
}

function issueCredential(random: UserProvisioningRandom): {
  userToken: string;
  credential: UserCredentialValues;
} {
  const secret = random.bytes(USER_TOKEN_SECRET_BYTES);
  if (secret.length !== USER_TOKEN_SECRET_BYTES) {
    throw new Error('Credential generator returned an invalid secret length');
  }
  const userToken = `usr_${secret.toString('base64url')}`;
  const tokenHash = createHash('sha256').update(userToken, 'utf8').digest();
  return {
    userToken,
    credential: {
      credentialId: random.uuid(),
      tokenHash,
      tokenHint: tokenHash.subarray(0, 6).toString('hex'),
    },
  };
}

function validateDeviceId(deviceId: string): void {
  if (!UUID_PATTERN.test(deviceId)) {
    throw new UserProvisioningValidationError('Device ID must be a UUID');
  }
}

function validateUserId(userId: string): void {
  if (!UUID_PATTERN.test(userId)) {
    throw new UserProvisioningValidationError('User ID must be a UUID');
  }
}
