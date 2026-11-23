import type { QueryResultRow } from 'pg';

import type { QueryExecutor } from '../devices/device.repository.js';

export interface DeviceCredentialIdentity {
  credentialId: string;
  deviceId: string;
}

export interface DeviceAuthenticationRepository {
  findActiveByTokenHash(tokenHash: Buffer): Promise<DeviceCredentialIdentity | null>;
  markUsedIfActive(credentialId: string): Promise<boolean>;
}

interface DeviceCredentialRow extends QueryResultRow {
  credential_id: string;
  device_id: string;
}

export function createDeviceAuthenticationRepository(
  database: QueryExecutor,
): DeviceAuthenticationRepository {
  return {
    async findActiveByTokenHash(tokenHash) {
      const result = await database.query<DeviceCredentialRow>(
        `SELECT credential_id, device_id
         FROM device_credentials
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash],
      );
      const row = result.rows[0];
      return row ? { credentialId: row.credential_id, deviceId: row.device_id } : null;
    },

    async markUsedIfActive(credentialId) {
      const result = await database.query<DeviceCredentialRow>(
        `UPDATE device_credentials
         SET last_used_at = GREATEST(
           COALESCE(last_used_at, '-infinity'::timestamptz),
           clock_timestamp()
         )
         WHERE credential_id = $1 AND revoked_at IS NULL
         RETURNING credential_id, device_id`,
        [credentialId],
      );
      return result.rows.length > 0;
    },
  };
}
