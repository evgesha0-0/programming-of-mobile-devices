import type { QueryResultRow } from 'pg';

import type { QueryExecutor } from '../devices/device.repository.js';
import type {
  DayOfWeek,
  DeletedScheduleRecord,
  ScheduleListRecord,
  ScheduleRecord,
  ScheduleValues,
} from './schedule.types.js';

export interface TransactionClient extends QueryExecutor {
  release(): void;
}

export interface TransactionPool extends QueryExecutor {
  connect(): Promise<TransactionClient>;
}

export interface ScheduleRepository {
  list(deviceId: string): Promise<ScheduleListRecord | null>;
  create(deviceId: string, scheduleId: string, values: ScheduleValues): Promise<ScheduleRecord | null>;
  update(deviceId: string, scheduleId: string, values: ScheduleValues): Promise<ScheduleRecord | null>;
  delete(deviceId: string, scheduleId: string): Promise<DeletedScheduleRecord | null>;
}

interface DeviceRevisionRow extends QueryResultRow {
  schedule_revision: string | number;
}

interface ScheduleRow extends QueryResultRow {
  schedule_id: string;
  device_id: string;
  time_local: string;
  days_of_week: DayOfWeek[];
  timezone: string;
  portion_grams: string | number;
  active: boolean;
  revision: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

interface DeletedScheduleRow extends QueryResultRow {
  schedule_id: string;
  revision: string | number;
  deleted_at: Date | string;
}

const scheduleColumns = `
  schedule_id,
  device_id,
  time_local::text,
  days_of_week,
  timezone,
  portion_grams,
  active,
  revision,
  created_at,
  updated_at,
  deleted_at
`;

export function createScheduleRepository(database: TransactionPool): ScheduleRepository {
  return {
    async list(deviceId) {
      const revisionResult = await database.query<DeviceRevisionRow>(
        'SELECT schedule_revision FROM devices WHERE device_id = $1',
        [deviceId],
      );
      const revision = revisionResult.rows[0];
      if (!revision) return null;

      const schedules = await database.query<ScheduleRow>(
        `SELECT ${scheduleColumns}
         FROM schedules
         WHERE device_id = $1 AND deleted_at IS NULL
         ORDER BY time_local, schedule_id`,
        [deviceId],
      );

      return {
        scheduleRevision: String(revision.schedule_revision),
        items: schedules.rows.map(mapSchedule),
      };
    },

    async create(deviceId, scheduleId, values) {
      return withTransaction(database, async (client) => {
        const revision = await incrementRevision(client, deviceId);
        if (revision === null) return null;

        const result = await client.query<ScheduleRow>(
          `INSERT INTO schedules (
             schedule_id, device_id, time_local, days_of_week, timezone,
             portion_grams, active, revision
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${scheduleColumns}`,
          [
            scheduleId,
            deviceId,
            values.timeLocal,
            values.daysOfWeek,
            values.timezone,
            values.portionGrams,
            values.active,
            revision,
          ],
        );
        return mapSchedule(requireRow(result.rows[0]));
      });
    },

    async update(deviceId, scheduleId, values) {
      return withTransaction(database, async (client) => {
        if (!await lockActiveSchedule(client, deviceId, scheduleId)) return null;
        const revision = await incrementRevision(client, deviceId);
        if (revision === null) return null;

        const result = await client.query<ScheduleRow>(
          `UPDATE schedules
           SET time_local = $3,
               days_of_week = $4,
               timezone = $5,
               portion_grams = $6,
               active = $7,
               revision = $8,
               updated_at = now()
           WHERE device_id = $1 AND schedule_id = $2 AND deleted_at IS NULL
           RETURNING ${scheduleColumns}`,
          [
            deviceId,
            scheduleId,
            values.timeLocal,
            values.daysOfWeek,
            values.timezone,
            values.portionGrams,
            values.active,
            revision,
          ],
        );
        return mapSchedule(requireRow(result.rows[0]));
      });
    },

    async delete(deviceId, scheduleId) {
      return withTransaction(database, async (client) => {
        if (!await lockActiveSchedule(client, deviceId, scheduleId)) return null;
        const revision = await incrementRevision(client, deviceId);
        if (revision === null) return null;

        const result = await client.query<DeletedScheduleRow>(
          `UPDATE schedules
           SET revision = $3, deleted_at = now(), updated_at = now()
           WHERE device_id = $1 AND schedule_id = $2 AND deleted_at IS NULL
           RETURNING schedule_id, revision, deleted_at`,
          [deviceId, scheduleId, revision],
        );
        const row = requireRow(result.rows[0]);
        return {
          scheduleId: row.schedule_id,
          scheduleRevision: String(row.revision),
          deletedAt: toDate(row.deleted_at),
        };
      });
    },
  };
}

async function incrementRevision(client: QueryExecutor, deviceId: string): Promise<string | null> {
  const result = await client.query<DeviceRevisionRow>(
    `UPDATE devices
     SET schedule_revision = schedule_revision + 1, updated_at = now()
     WHERE device_id = $1
     RETURNING schedule_revision`,
    [deviceId],
  );
  const row = result.rows[0];
  return row ? String(row.schedule_revision) : null;
}

async function lockActiveSchedule(
  client: QueryExecutor,
  deviceId: string,
  scheduleId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT schedule_id FROM schedules
     WHERE device_id = $1 AND schedule_id = $2 AND deleted_at IS NULL
     FOR UPDATE`,
    [deviceId, scheduleId],
  );
  return result.rows.length > 0;
}

async function withTransaction<T>(
  database: TransactionPool,
  operation: (client: TransactionClient) => Promise<T>,
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

function mapSchedule(row: ScheduleRow): ScheduleRecord {
  return {
    scheduleId: row.schedule_id,
    deviceId: row.device_id,
    timeLocal: row.time_local,
    daysOfWeek: row.days_of_week,
    timezone: row.timezone,
    portionGrams: String(row.portion_grams),
    active: row.active,
    revision: String(row.revision),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    deletedAt: row.deleted_at === null ? null : toDate(row.deleted_at),
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function requireRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Database did not return the modified schedule');
  return row;
}

