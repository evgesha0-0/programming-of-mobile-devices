import type { QueryResultRow } from 'pg';

import type { QueryExecutor } from '../devices/device.repository.js';

export interface DeviceCredentialValues {
  credentialId: string;
  tokenHash: Buffer;
  tokenHint: string;
}

export interface NewDeviceValues {
  deviceId: string;
  name: string;
  credential: DeviceCredentialValues;
}

export type RevokeDeviceCredentialResult = 'revoked' | 'already_revoked' | 'device_not_found';

export interface DeviceProvisioningRepository {
  createDevice(values: NewDeviceValues): Promise<void>;
  rotateCredential(deviceId: string, credential: DeviceCredentialValues): Promise<boolean>;
  revokeCredential(deviceId: string): Promise<RevokeDeviceCredentialResult>;
}

interface ProvisioningClient extends QueryExecutor {
  release(): void;
}

export interface ProvisioningDatabase extends QueryExecutor {
  connect(): Promise<ProvisioningClient>;
}

interface DeviceRow extends QueryResultRow {
  device_id: string;
}

interface CredentialRow extends QueryResultRow {
  credential_id: string;
}

export function createDeviceProvisioningRepository(
  database: ProvisioningDatabase,
): DeviceProvisioningRepository {
  return {
    async createDevice(values) {
      await withTransaction(database, async (client) => {
        await client.query(
          'INSERT INTO devices (device_id, name) VALUES ($1, $2)',
          [values.deviceId, values.name],
        );
        await insertCredential(client, values.deviceId, values.credential);
      });
    },

    async rotateCredential(deviceId, credential) {
      return withTransaction(database, async (client) => {
        if (!await lockDevice(client, deviceId)) return false;

        await client.query(
          `UPDATE device_credentials
           SET revoked_at = clock_timestamp()
           WHERE device_id = $1 AND revoked_at IS NULL`,
          [deviceId],
        );
        await insertCredential(client, deviceId, credential);
        return true;
      });
    },

    async revokeCredential(deviceId) {
      return withTransaction(database, async (client) => {
        if (!await lockDevice(client, deviceId)) return 'device_not_found';

        const result = await client.query<CredentialRow>(
          `UPDATE device_credentials
           SET revoked_at = clock_timestamp()
           WHERE device_id = $1 AND revoked_at IS NULL
           RETURNING credential_id`,
          [deviceId],
        );
        return result.rows.length > 0 ? 'revoked' : 'already_revoked';
      });
    },
  };
}

async function insertCredential(
  client: QueryExecutor,
  deviceId: string,
  credential: DeviceCredentialValues,
): Promise<void> {
  await client.query(
    `INSERT INTO device_credentials (
       credential_id, device_id, token_hash, token_hint
     ) VALUES ($1, $2, $3, $4)`,
    [credential.credentialId, deviceId, credential.tokenHash, credential.tokenHint],
  );
}

async function lockDevice(client: QueryExecutor, deviceId: string): Promise<boolean> {
  const result = await client.query<DeviceRow>(
    'SELECT device_id FROM devices WHERE device_id = $1 FOR UPDATE',
    [deviceId],
  );
  return result.rows.length > 0;
}

async function withTransaction<T>(
  database: ProvisioningDatabase,
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
      // Preserve the original database error.
    }
    throw error;
  } finally {
    client.release();
  }
}
