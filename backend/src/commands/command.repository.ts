import type { QueryResultRow } from 'pg';

import type { QueryExecutor } from '../devices/device.repository.js';
import type {
  CreateManualCommandResult,
  FeedingStatus,
  ListPendingCommandsResult,
  ManualCommandRecord,
  ManualCommandValues,
  PendingCommandRecord,
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

function requireCommand(command: ManualCommandRecord | null): ManualCommandRecord {
  if (!command) throw new Error('Database did not return the manual command');
  return command;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

