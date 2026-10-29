import type { QueryResultRow } from 'pg';

import type {
  DeviceStateRecord,
  DeviceStateUpdate,
  DeviceStatus,
  UpdatedDeviceStateRecord,
} from './device.types.js';

export interface QueryExecutor {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface DeviceRepository {
  findState(deviceId: string): Promise<DeviceStateRecord | null>;
  updateStateIfNewer(
    deviceId: string,
    update: DeviceStateUpdate,
  ): Promise<UpdatedDeviceStateRecord | null>;
}

interface DeviceStateRow extends QueryResultRow {
  device_id: string;
  status: DeviceStatus;
  firmware_version: string | null;
  last_seen_at: Date | null;
  schedule_revision: string | number;
  last_error_code: string | null;
  last_error_message: string | null;
}

interface UpdatedDeviceStateRow extends DeviceStateRow {
  server_time: Date;
}

const stateColumns = `
  device_id,
  status,
  firmware_version,
  last_seen_at,
  schedule_revision,
  last_error_code,
  last_error_message
`;

export function createDeviceRepository(database: QueryExecutor): DeviceRepository {
  return {
    async findState(deviceId) {
      const result = await database.query<DeviceStateRow>(
        `SELECT ${stateColumns} FROM devices WHERE device_id = $1`,
        [deviceId],
      );

      const row = result.rows[0];
      return row ? mapState(row) : null;
    },

    async updateStateIfNewer(deviceId, update) {
      const result = await database.query<UpdatedDeviceStateRow>(
        `UPDATE devices
         SET status = $2,
             firmware_version = $3,
             last_seen_at = $4,
             last_error_code = $5,
             last_error_message = $6,
             updated_at = now()
         WHERE device_id = $1
           AND (last_seen_at IS NULL OR last_seen_at < $4)
         RETURNING ${stateColumns}, now() AS server_time`,
        [
          deviceId,
          update.status,
          update.firmwareVersion,
          update.reportedAt,
          update.errorCode,
          update.errorMessage,
        ],
      );

      const row = result.rows[0];
      return row ? { ...mapState(row), serverTime: row.server_time } : null;
    },
  };
}

function mapState(row: DeviceStateRow): DeviceStateRecord {
  return {
    deviceId: row.device_id,
    status: row.status,
    firmwareVersion: row.firmware_version,
    lastSeenAt: row.last_seen_at,
    scheduleRevision: String(row.schedule_revision),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
  };
}

