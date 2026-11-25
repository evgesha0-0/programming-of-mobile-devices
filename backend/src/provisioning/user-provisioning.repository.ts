import type { QueryResultRow } from 'pg';

import type { QueryExecutor } from '../devices/device.repository.js';

export interface UserCredentialValues {
  credentialId: string;
  tokenHash: Buffer;
  tokenHint: string;
}

export interface NewOwnerValues {
  userId: string;
  deviceId: string;
  userDeviceId: string;
  credential: UserCredentialValues;
}

export type ProvisionOwnerResult = 'created' | 'device_not_found' | 'owner_exists';
export type RevokeUserCredentialResult = 'revoked' | 'already_revoked' | 'user_not_found';

export interface UserProvisioningRepository {
  provisionOwner(values: NewOwnerValues): Promise<ProvisionOwnerResult>;
  rotateCredential(userId: string, credential: UserCredentialValues): Promise<boolean>;
  revokeCredential(userId: string): Promise<RevokeUserCredentialResult>;
}

interface ProvisioningClient extends QueryExecutor {
  release(): void;
}

export interface UserProvisioningDatabase extends QueryExecutor {
  connect(): Promise<ProvisioningClient>;
}

interface DeviceRow extends QueryResultRow {
  device_id: string;
}

interface OwnerRow extends QueryResultRow {
  user_device_id: string;
}

interface UserRow extends QueryResultRow {
  user_id: string;
}

interface CredentialRow extends QueryResultRow {
  credential_id: string;
}

export function createUserProvisioningRepository(
  database: UserProvisioningDatabase,
): UserProvisioningRepository {
  return {
    async provisionOwner(values) {
      return withTransaction(database, async (client) => {
        const device = await client.query<DeviceRow>(
          'SELECT device_id FROM devices WHERE device_id = $1 FOR UPDATE',
          [values.deviceId],
        );
        if (!device.rows[0]) return 'device_not_found';

        const owner = await client.query<OwnerRow>(
          `SELECT user_device_id
           FROM user_devices
           WHERE device_id = $1 AND role = 'owner' AND revoked_at IS NULL`,
          [values.deviceId],
        );
        if (owner.rows[0]) return 'owner_exists';

        await client.query(
          'INSERT INTO users(user_id) VALUES ($1)',
          [values.userId],
        );
        await insertCredential(client, values.userId, values.credential);
        await client.query(
          `INSERT INTO user_devices(
             user_device_id, user_id, device_id, role
           ) VALUES ($1, $2, $3, 'owner')`,
          [values.userDeviceId, values.userId, values.deviceId],
        );
        return 'created';
      });
    },

    async rotateCredential(userId, credential) {
      return withTransaction(database, async (client) => {
        if (!await lockUser(client, userId)) return false;

        await client.query(
          `UPDATE user_credentials
           SET revoked_at = clock_timestamp()
           WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId],
        );
        await insertCredential(client, userId, credential);
        return true;
      });
    },

    async revokeCredential(userId) {
      return withTransaction(database, async (client) => {
        if (!await lockUser(client, userId)) return 'user_not_found';

        const result = await client.query<CredentialRow>(
          `UPDATE user_credentials
           SET revoked_at = clock_timestamp()
           WHERE user_id = $1 AND revoked_at IS NULL
           RETURNING credential_id`,
          [userId],
        );
        return result.rows.length > 0 ? 'revoked' : 'already_revoked';
      });
    },
  };
}

async function insertCredential(
  client: QueryExecutor,
  userId: string,
  credential: UserCredentialValues,
): Promise<void> {
  await client.query(
    `INSERT INTO user_credentials(
       credential_id, user_id, token_hash, token_hint
     ) VALUES ($1, $2, $3, $4)`,
    [credential.credentialId, userId, credential.tokenHash, credential.tokenHint],
  );
}

async function lockUser(client: QueryExecutor, userId: string): Promise<boolean> {
  const result = await client.query<UserRow>(
    'SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  return result.rows.length > 0;
}

async function withTransaction<T>(
  database: UserProvisioningDatabase,
  operation: (client: ProvisioningClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original provisioning error.
    }
    throw error;
  } finally {
    client.release();
  }
}
