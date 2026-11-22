import type { QueryResultRow } from 'pg';

import type { QueryExecutor } from '../devices/device.repository.js';

export type UserDeviceRole = 'owner' | 'viewer';

export interface UserDeviceAccess {
  userId: string;
  deviceId: string;
  role: UserDeviceRole;
}

export interface UserCredentialIdentity {
  credentialId: string;
  userId: string;
}

export interface UserAuthenticationRepository {
  authenticateToken(tokenHash: Buffer): Promise<UserCredentialIdentity | null>;
  findActiveAccess(userId: string, deviceId: string): Promise<UserDeviceAccess | null>;
}

interface UserCredentialRow extends QueryResultRow {
  credential_id: string;
  user_id: string;
}

interface UserDeviceAccessRow extends QueryResultRow {
  device_id: string;
  role: UserDeviceRole;
}

export function createUserAuthenticationRepository(
  database: QueryExecutor,
): UserAuthenticationRepository {
  return {
    async authenticateToken(tokenHash) {
      const result = await database.query<UserCredentialRow>(
        `UPDATE user_credentials AS credential
         SET last_used_at = GREATEST(
           COALESCE(credential.last_used_at, '-infinity'::timestamptz),
           clock_timestamp()
         )
         FROM users AS account
         WHERE credential.token_hash = $1
           AND credential.revoked_at IS NULL
           AND account.user_id = credential.user_id
           AND account.disabled_at IS NULL
         RETURNING credential.credential_id, credential.user_id`,
        [tokenHash],
      );
      const row = result.rows[0];
      return row ? { credentialId: row.credential_id, userId: row.user_id } : null;
    },

    async findActiveAccess(userId, deviceId) {
      const result = await database.query<UserDeviceAccessRow>(
        `SELECT device_id, role
         FROM user_devices
         WHERE user_id = $1
           AND device_id = $2
           AND revoked_at IS NULL
        `,
        [userId, deviceId],
      );
      const row = result.rows[0];
      return row ? { userId, deviceId: row.device_id, role: row.role } : null;
    },
  };
}
