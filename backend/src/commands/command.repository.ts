import type { QueryResultRow } from 'pg';

import type { QueryExecutor } from '../devices/device.repository.js';
import type {
  AcknowledgeCommandResult,
  AcknowledgeCommandValues,
  AcknowledgedCommandRecord,
  CreateManualCommandResult,
  FeedingStatus,
  ListPendingCommandsResult,
  ManualCommandRecord,
  ManualCommandValues,
  ManualFeedingResultRecord,
  ManualFeedingResultValues,
  PendingCommandRecord,
  SubmitManualFeedingResult,
} from './command.types.js';

interface CommandTransactionClient extends QueryExecutor {
  release(): void;
}

export interface CommandDatabase extends QueryExecutor {
  connect(): Promise<CommandTransactionClient>;
}

export interface CommandRepository {
  create(values: ManualCommandValues): Promise<CreateManualCommandResult>;
  listPending(deviceId: string, limit: number): Promise<ListPendingCommandsResult>;
  acknowledge(values: AcknowledgeCommandValues): Promise<AcknowledgeCommandResult>;
  submitResult(values: ManualFeedingResultValues): Promise<SubmitManualFeedingResult>;
}

interface InsertedCommandRow extends QueryResultRow {
  command_id: string;
}

interface ManualCommandRow extends QueryResultRow {
  command_id: string;
  feeding_id: string;
  device_id: string;
  portion_grams: string | number;
  status: FeedingStatus;
  created_at: Date | string;
  expires_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  actual_grams: string | number | null;
  error_code: string | null;
}

interface PendingCommandRow extends QueryResultRow {
  server_time: Date | string;
  command_id: string | null;
  feeding_id: string | null;
  device_id: string | null;
  portion_grams: string | number | null;
  status: 'pending' | null;
  created_at: Date | string | null;
  expires_at: Date | string | null;
}

interface AcknowledgeCommandRow extends QueryResultRow {
  feeding_id: string;
  status: FeedingStatus;
  created_at: Date | string;
  expires_at: Date | string;
  started_at: Date | string | null;
  feeding_status: FeedingStatus;
  feeding_started_at: Date | string | null;
  server_time: Date | string;
}

interface ManualResultRow extends QueryResultRow {
  command_id: string;
  command_status: FeedingStatus;
  command_portion_grams: string | number;
  command_started_at: Date | string | null;
  command_finished_at: Date | string | null;
  command_error_code: string | null;
  feeding_source: 'manual' | 'scheduled';
  feeding_status: FeedingStatus;
  feeding_portion_grams: string | number;
  feeding_started_at: Date | string | null;
  feeding_finished_at: Date | string | null;
  actual_grams: string | number | null;
  feeding_error_code: string | null;
  feeding_error_message: string | null;
}

export function createCommandRepository(database: CommandDatabase): CommandRepository {
  return {
    async create(values) {
      const client = await database.connect();
      try {
        await client.query('BEGIN');

        const device = await client.query(
          'SELECT device_id FROM devices WHERE device_id = $1',
          [values.deviceId],
        );
        if (device.rows.length === 0) {
          await client.query('COMMIT');
          return { kind: 'device_not_found' };
        }

        const existingBeforeInsert = await findCommand(client, values.commandId);
        if (existingBeforeInsert) {
          await client.query('COMMIT');
          return isSameCommand(existingBeforeInsert, values)
            ? { kind: 'repeated', command: existingBeforeInsert }
            : { kind: 'conflict' };
        }

        if (values.expiresAt <= values.createdAt) {
          await client.query('COMMIT');
          return { kind: 'invalid_expiry' };
        }

        const inserted = await client.query<InsertedCommandRow>(
          `INSERT INTO feeding_commands (
             command_id, feeding_id, device_id, portion_grams, status, created_at, expires_at
           ) VALUES ($1, $2, $3, $4, 'pending', $5, $6)
           ON CONFLICT (command_id) DO NOTHING
           RETURNING command_id`,
          [
            values.commandId,
            values.feedingId,
            values.deviceId,
            values.portionGrams,
            values.createdAt,
            values.expiresAt,
          ],
        );

        if (inserted.rows.length > 0) {
          await client.query(
            `INSERT INTO feedings (
               feeding_id, device_id, command_id, source, portion_grams, status, created_at
             ) VALUES ($1, $2, $3, 'manual', $4, 'pending', $5)`,
            [
              values.feedingId,
              values.deviceId,
              values.commandId,
              values.portionGrams,
              values.createdAt,
            ],
          );
          const command = await findCommand(client, values.commandId);
          await client.query('COMMIT');
          return { kind: 'created', command: requireCommand(command) };
        }

        const existing = requireCommand(await findCommand(client, values.commandId));
        const repeated = isSameCommand(existing, values);
        await client.query('COMMIT');
        return repeated
          ? { kind: 'repeated', command: existing }
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

    async listPending(deviceId, limit) {
      const client = await database.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `WITH expired AS (
             UPDATE feeding_commands
             SET status = 'expired', finished_at = now()
             WHERE device_id = $1
               AND status = 'pending'
               AND expires_at <= now()
             RETURNING device_id, feeding_id
           )
           UPDATE feedings AS f
           SET status = 'expired', finished_at = now()
           FROM expired AS e
           WHERE f.device_id = e.device_id
             AND f.feeding_id = e.feeding_id
             AND f.status = 'pending'`,
          [deviceId],
        );

        const result = await client.query<PendingCommandRow>(
          `SELECT
             now() AS server_time,
             command.command_id,
             command.feeding_id,
             command.device_id,
             command.portion_grams,
             command.status,
             command.created_at,
             command.expires_at
           FROM devices AS device
           LEFT JOIN LATERAL (
             SELECT
               command_id,
               feeding_id,
               device_id,
               portion_grams,
               status,
               created_at,
               expires_at
             FROM feeding_commands
             WHERE device_id = device.device_id
               AND status = 'pending'
               AND expires_at > now()
             ORDER BY created_at, command_id
             LIMIT $2
           ) AS command ON true
           WHERE device.device_id = $1
           ORDER BY command.created_at, command.command_id`,
          [deviceId, limit],
        );

        const first = result.rows[0];
        if (!first) {
          await client.query('COMMIT');
          return { kind: 'device_not_found' };
        }

        const commands = {
          serverTime: toDate(first.server_time),
          items: result.rows.flatMap((row) => row.command_id === null ? [] : [mapPending(row)]),
        };
        await client.query('COMMIT');
        return { kind: 'found', commands };
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

    async acknowledge(values) {
      const client = await database.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<AcknowledgeCommandRow>(
          `SELECT
             command.feeding_id,
             command.status,
             command.created_at,
             command.expires_at,
             command.started_at,
             feeding.status AS feeding_status,
             feeding.started_at AS feeding_started_at,
             now() AS server_time
           FROM feeding_commands AS command
           JOIN feedings AS feeding
             ON feeding.device_id = command.device_id
            AND feeding.command_id = command.command_id
            AND feeding.feeding_id = command.feeding_id
           WHERE command.device_id = $1 AND command.command_id = $2
           FOR UPDATE OF command, feeding`,
          [values.deviceId, values.commandId],
        );
        const row = result.rows[0];
        if (!row) {
          await client.query('COMMIT');
          return { kind: 'not_found' };
        }

        if (row.feeding_id !== values.feedingId) {
          await client.query('COMMIT');
          return { kind: 'conflict' };
        }

        if (row.status === 'running') {
          const commandStartedAt = nullableDate(row.started_at);
          const feedingStartedAt = nullableDate(row.feeding_started_at);
          const exactRepeat = row.feeding_status === 'running'
            && commandStartedAt?.getTime() === values.startedAt.getTime()
            && feedingStartedAt?.getTime() === values.startedAt.getTime();
          await client.query('COMMIT');
          return exactRepeat
            ? { kind: 'acknowledged', command: acknowledgedRecord(values) }
            : { kind: 'conflict' };
        }

        if (row.status !== 'pending' || row.feeding_status !== 'pending') {
          await client.query('COMMIT');
          return { kind: 'conflict' };
        }

        if (toDate(row.expires_at) <= toDate(row.server_time)) {
          await client.query(
            `UPDATE feeding_commands
             SET status = 'expired', finished_at = now()
             WHERE device_id = $1 AND command_id = $2 AND status = 'pending'`,
            [values.deviceId, values.commandId],
          );
          await client.query(
            `UPDATE feedings
             SET status = 'expired', finished_at = now()
             WHERE device_id = $1 AND feeding_id = $2 AND status = 'pending'`,
            [values.deviceId, values.feedingId],
          );
          await client.query('COMMIT');
          return { kind: 'conflict' };
        }

        if (values.startedAt < toDate(row.created_at)) {
          await client.query('COMMIT');
          return { kind: 'invalid_started_at' };
        }

        const updatedCommand = await client.query(
          `UPDATE feeding_commands
           SET status = 'running', started_at = $3
           WHERE device_id = $1 AND command_id = $2 AND status = 'pending'
           RETURNING command_id`,
          [values.deviceId, values.commandId, values.startedAt],
        );
        const updatedFeeding = await client.query(
          `UPDATE feedings
           SET status = 'running', started_at = $3
           WHERE device_id = $1 AND feeding_id = $2 AND status = 'pending'
           RETURNING feeding_id`,
          [values.deviceId, values.feedingId, values.startedAt],
        );
        if (updatedCommand.rows.length !== 1 || updatedFeeding.rows.length !== 1) {
          throw new Error('Database did not acknowledge the manual command consistently');
        }

        await client.query('COMMIT');
        return { kind: 'acknowledged', command: acknowledgedRecord(values) };
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

    async submitResult(values) {
      const client = await database.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<ManualResultRow>(
          `SELECT
             command.command_id,
             command.status AS command_status,
             command.portion_grams AS command_portion_grams,
             command.started_at AS command_started_at,
             command.finished_at AS command_finished_at,
             command.error_code AS command_error_code,
             feeding.source AS feeding_source,
             feeding.status AS feeding_status,
             feeding.portion_grams AS feeding_portion_grams,
             feeding.started_at AS feeding_started_at,
             feeding.finished_at AS feeding_finished_at,
             feeding.actual_grams,
             feeding.error_code AS feeding_error_code,
             feeding.error_message AS feeding_error_message
           FROM feedings AS feeding
           JOIN feeding_commands AS command
             ON command.device_id = feeding.device_id
            AND command.command_id = feeding.command_id
            AND command.feeding_id = feeding.feeding_id
           WHERE feeding.device_id = $1 AND feeding.feeding_id = $2
           FOR UPDATE OF command, feeding`,
          [values.deviceId, values.feedingId],
        );
        const row = result.rows[0];
        if (!row) {
          await client.query('COMMIT');
          return { kind: 'not_found' };
        }

        const identityMatches = row.command_id === values.commandId
          && row.feeding_source === values.source
          && Number(row.command_portion_grams) === values.portionGrams
          && Number(row.feeding_portion_grams) === values.portionGrams
          && sameNullableDate(row.command_started_at, values.startedAt)
          && sameNullableDate(row.feeding_started_at, values.startedAt);
        if (!identityMatches) {
          await client.query('COMMIT');
          return { kind: 'conflict' };
        }

        if (values.finishedAt < values.startedAt) {
          await client.query('COMMIT');
          return { kind: 'invalid_timeline' };
        }

        if (row.command_status === 'completed' || row.command_status === 'failed') {
          const exactRepeat = isExactManualResult(row, values);
          await client.query('COMMIT');
          return exactRepeat
            ? { kind: 'accepted', result: manualResultRecord(values) }
            : { kind: 'conflict' };
        }

        if (row.command_status !== 'running' || row.feeding_status !== 'running') {
          await client.query('COMMIT');
          return { kind: 'conflict' };
        }

        const updatedCommand = await client.query(
          `UPDATE feeding_commands
           SET status = $3, finished_at = $4, error_code = $5
           WHERE device_id = $1 AND command_id = $2 AND status = 'running'
           RETURNING command_id`,
          [
            values.deviceId,
            values.commandId,
            values.status,
            values.finishedAt,
            values.errorCode,
          ],
        );
        const updatedFeeding = await client.query(
          `UPDATE feedings
           SET status = $3,
               actual_grams = $4,
               finished_at = $5,
               error_code = $6,
               error_message = $7
           WHERE device_id = $1 AND feeding_id = $2 AND status = 'running'
           RETURNING feeding_id`,
          [
            values.deviceId,
            values.feedingId,
            values.status,
            values.actualGrams,
            values.finishedAt,
            values.errorCode,
            values.errorMessage,
          ],
        );
        if (updatedCommand.rows.length !== 1 || updatedFeeding.rows.length !== 1) {
          throw new Error('Database did not save the manual feeding result consistently');
        }

        await client.query('COMMIT');
        return { kind: 'accepted', result: manualResultRecord(values) };
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

async function findCommand(
  database: QueryExecutor,
  commandId: string,
): Promise<ManualCommandRecord | null> {
  const result = await database.query<ManualCommandRow>(
    `SELECT
       c.command_id,
       c.feeding_id,
       c.device_id,
       c.portion_grams,
       c.status,
       c.created_at,
       c.expires_at,
       c.started_at,
       c.finished_at,
       f.actual_grams,
       c.error_code
     FROM feeding_commands c
     LEFT JOIN feedings f
       ON f.device_id = c.device_id
      AND f.command_id = c.command_id
      AND f.feeding_id = c.feeding_id
     WHERE c.command_id = $1`,
    [commandId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    commandId: row.command_id,
    feedingId: row.feeding_id,
    deviceId: row.device_id,
    portionGrams: String(row.portion_grams),
    status: row.status,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
    startedAt: row.started_at === null ? null : toDate(row.started_at),
    finishedAt: row.finished_at === null ? null : toDate(row.finished_at),
    actualGrams: row.actual_grams === null ? null : String(row.actual_grams),
    errorCode: row.error_code,
  };
}

function isSameCommand(command: ManualCommandRecord, values: ManualCommandValues): boolean {
  return command.deviceId === values.deviceId
    && Number(command.portionGrams) === values.portionGrams
    && command.expiresAt.getTime() === values.expiresAt.getTime();
}

function mapPending(row: PendingCommandRow): PendingCommandRecord {
  if (
    row.command_id === null
    || row.feeding_id === null
    || row.device_id === null
    || row.portion_grams === null
    || row.status !== 'pending'
    || row.created_at === null
    || row.expires_at === null
  ) {
    throw new Error('Database returned an incomplete pending command');
  }

  return {
    commandId: row.command_id,
    feedingId: row.feeding_id,
    deviceId: row.device_id,
    portionGrams: String(row.portion_grams),
    status: row.status,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
  };
}

function acknowledgedRecord(values: AcknowledgeCommandValues): AcknowledgedCommandRecord {
  return {
    commandId: values.commandId,
    feedingId: values.feedingId,
    status: 'running',
    startedAt: values.startedAt,
  };
}

function nullableDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

function sameNullableDate(value: Date | string | null, expected: Date): boolean {
  return nullableDate(value)?.getTime() === expected.getTime();
}

function sameNullableNumber(value: string | number | null, expected: number | null): boolean {
  return value === null ? expected === null : expected !== null && Number(value) === expected;
}

function isExactManualResult(row: ManualResultRow, values: ManualFeedingResultValues): boolean {
  return row.command_status === values.status
    && row.feeding_status === values.status
    && sameNullableDate(row.command_finished_at, values.finishedAt)
    && sameNullableDate(row.feeding_finished_at, values.finishedAt)
    && sameNullableNumber(row.actual_grams, values.actualGrams)
    && row.command_error_code === values.errorCode
    && row.feeding_error_code === values.errorCode
    && row.feeding_error_message === values.errorMessage;
}

function manualResultRecord(values: ManualFeedingResultValues): ManualFeedingResultRecord {
  return {
    feedingId: values.feedingId,
    commandId: values.commandId,
    status: values.status,
    actualGrams: values.actualGrams === null ? null : String(values.actualGrams),
    finishedAt: values.finishedAt,
  };
}

function requireCommand(command: ManualCommandRecord | null): ManualCommandRecord {
  if (!command) throw new Error('Database did not return the manual command');
  return command;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

