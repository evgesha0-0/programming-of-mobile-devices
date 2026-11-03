import type { QueryResultRow } from 'pg';

import type { QueryExecutor } from '../devices/device.repository.js';
import type {
  CreateScheduledFeedingEventResult,
  ScheduledFeedingEventRecord,
  ScheduledFeedingEventValues,
  ScheduledFeedingStatus,
} from './feeding.types.js';

interface FeedingTransactionClient extends QueryExecutor {
  release(): void;
}

export interface FeedingDatabase extends QueryExecutor {
  connect(): Promise<FeedingTransactionClient>;
}

export interface FeedingRepository {
  createScheduledEvent(
    values: ScheduledFeedingEventValues,
  ): Promise<CreateScheduledFeedingEventResult>;
}

interface ScheduledFeedingRow extends QueryResultRow {
  feeding_id: string;
  device_id: string;
  schedule_id: string | null;
  source: 'manual' | 'scheduled';
  portion_grams: string | number;
  actual_grams: string | number | null;
  status: ScheduledFeedingStatus;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  error_code: string | null;
  error_message: string | null;
  received_at: Date | string;
}

export function createFeedingRepository(database: FeedingDatabase): FeedingRepository {
  return {
    async createScheduledEvent(values) {
      const client = await database.connect();
      try {
        await client.query('BEGIN');

        const schedule = await client.query(
          `SELECT schedule_id
           FROM schedules
           WHERE device_id = $1 AND schedule_id = $2`,
          [values.deviceId, values.scheduleId],
        );
        if (schedule.rows.length === 0) {
          await client.query('COMMIT');
          return { kind: 'not_found' };
        }

        const existingBeforeInsert = await findFeeding(client, values.feedingId);
        if (existingBeforeInsert) {
          await client.query('COMMIT');
          return isSameScheduledEvent(existingBeforeInsert, values)
            ? { kind: 'repeated', event: toEventRecord(existingBeforeInsert) }
            : { kind: 'conflict' };
        }

        if (values.startedAt < values.createdAt || values.finishedAt < values.startedAt) {
          await client.query('COMMIT');
          return { kind: 'invalid_timeline' };
        }

        const inserted = await client.query<ScheduledFeedingRow>(
          `INSERT INTO feedings (
             feeding_id,
             device_id,
             schedule_id,
             source,
             portion_grams,
             actual_grams,
             status,
             created_at,
             started_at,
             finished_at,
             error_code,
             error_message
           ) VALUES ($1, $2, $3, 'scheduled', $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (feeding_id) DO NOTHING
           RETURNING *`,
          [
            values.feedingId,
            values.deviceId,
            values.scheduleId,
            values.portionGrams,
            values.actualGrams,
            values.status,
            values.createdAt,
            values.startedAt,
            values.finishedAt,
            values.errorCode,
            values.errorMessage,
          ],
        );
        const insertedRow = inserted.rows[0];
        if (insertedRow) {
          await client.query('COMMIT');
          return { kind: 'created', event: toEventRecord(insertedRow) };
        }

        const existing = await findFeeding(client, values.feedingId);
        if (!existing) throw new Error('Database did not return the existing feeding event');
        const repeated = isSameScheduledEvent(existing, values);
        await client.query('COMMIT');
        return repeated
          ? { kind: 'repeated', event: toEventRecord(existing) }
          : { kind: 'conflict' };
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
    },
  };
}

async function findFeeding(
  database: QueryExecutor,
  feedingId: string,
): Promise<ScheduledFeedingRow | null> {
  const result = await database.query<ScheduledFeedingRow>(
    `SELECT
       feeding_id,
       device_id,
       schedule_id,
       source,
       portion_grams,
       actual_grams,
       status,
       created_at,
       started_at,
       finished_at,
       error_code,
       error_message,
       received_at
     FROM feedings
     WHERE feeding_id = $1`,
    [feedingId],
  );
  return result.rows[0] ?? null;
}

function isSameScheduledEvent(
  row: ScheduledFeedingRow,
  values: ScheduledFeedingEventValues,
): boolean {
  return row.device_id === values.deviceId
    && row.schedule_id === values.scheduleId
    && row.source === values.source
    && Number(row.portion_grams) === values.portionGrams
    && sameNullableNumber(row.actual_grams, values.actualGrams)
    && row.status === values.status
    && toDate(row.created_at).getTime() === values.createdAt.getTime()
    && nullableDate(row.started_at)?.getTime() === values.startedAt.getTime()
    && nullableDate(row.finished_at)?.getTime() === values.finishedAt.getTime()
    && row.error_code === values.errorCode
    && row.error_message === values.errorMessage;
}

function toEventRecord(row: ScheduledFeedingRow): ScheduledFeedingEventRecord {
  if (row.schedule_id === null || row.source !== 'scheduled') {
    throw new Error('Database returned a non-scheduled feeding event');
  }
  return {
    feedingId: row.feeding_id,
    deviceId: row.device_id,
    scheduleId: row.schedule_id,
    source: row.source,
    status: row.status,
    actualGrams: row.actual_grams === null ? null : String(row.actual_grams),
    receivedAt: toDate(row.received_at),
  };
}

function sameNullableNumber(value: string | number | null, expected: number | null): boolean {
  return value === null ? expected === null : expected !== null && Number(value) === expected;
}

function nullableDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

