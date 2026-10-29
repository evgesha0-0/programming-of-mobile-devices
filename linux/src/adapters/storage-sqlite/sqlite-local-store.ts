import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  actualGramsSchema,
  daysOfWeekSchema,
  feedingIdSchema,
  localTimeSchema,
  portionGramsSchema,
  scheduleIdSchema,
  timezoneSchema,
  utcDateTimeSchema,
  type UtcDateTime,
} from '../../domain/index.js';
import {
  OutboxConflictError,
  ScheduleOccurrenceConflictError,
  ScheduleRevisionConflictError,
  StaleScheduleRevisionError,
  type LocalSchedule,
  type LocalScheduleSnapshot,
  type LocalStore,
  type NewOutboxMessage,
  type OutboxKind,
  type OutboxMessage,
  type ScheduleOccurrenceClaim,
} from '../../ports/index.js';
import { runMigrations } from './migration-runner.js';
import { ProcessLock } from './process-lock.js';

const defaultMigrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../migrations',
);
const outboxKinds = new Set<OutboxKind>(['state', 'ack', 'manual_result', 'scheduled_event']);

export interface SqliteLocalStoreOptions {
  databasePath: string;
  migrationsDirectory?: string;
}

export class SqliteLocalStore implements LocalStore {
  static open(options: SqliteLocalStoreOptions): SqliteLocalStore {
    if (options.databasePath.trim().length === 0) {
      throw new TypeError('databasePath must not be empty');
    }

    mkdirSync(dirname(options.databasePath), { recursive: true });
    const lock = ProcessLock.acquire(`${options.databasePath}.lock`);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(options.databasePath);
      database.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
      `);
      runMigrations(database, options.migrationsDirectory ?? defaultMigrationsDirectory);
      return new SqliteLocalStore(database, lock);
    } catch (error) {
      if (database?.isOpen) database.close();
      lock.release();
      throw error;
    }
  }

  private closed = false;

  private constructor(
    private readonly database: DatabaseSync,
    private readonly lock: ProcessLock,
  ) {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.database.isOpen) this.database.close();
    } finally {
      this.lock.release();
    }
  }

  getSchemaVersion(): number {
    this.assertOpen();
    const row = this.database.prepare(
      'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
    ).get();
    return readNumber(row, 'version');
  }

  getScheduleSnapshot(): LocalScheduleSnapshot | null {
    this.assertOpen();
    const revisionValue = this.getMetadata('schedule_revision');
    if (revisionValue === undefined) return null;

    const revision = Number(revisionValue);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error('Invalid local schedule revision');
    }
    const generatedAt = utcDateTimeSchema.parse(
      this.requireMetadata('schedule_generated_at'),
    );
    const rows = this.database.prepare(`
      SELECT
        schedule_id,
        time_local,
        days_of_week_json,
        timezone,
        portion_grams_cents,
        active,
        updated_at,
        deleted_at
      FROM schedules
      ORDER BY schedule_id
    `).all();

    return {
      revision,
      generatedAt,
      items: rows.map(readSchedule),
    };
  }

  replaceScheduleSnapshot(snapshot: LocalScheduleSnapshot): void {
    this.assertOpen();
    validateSnapshot(snapshot);
    const hash = hashSnapshot(snapshot.items);

    this.transaction(() => {
      const currentRevisionValue = this.getMetadata('schedule_revision');
      if (currentRevisionValue !== undefined) {
        const currentRevision = Number(currentRevisionValue);
        if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
          throw new Error('Invalid local schedule revision');
        }
        if (snapshot.revision < currentRevision) {
          throw new StaleScheduleRevisionError(snapshot.revision, currentRevision);
        }
        if (snapshot.revision === currentRevision) {
          if (this.requireMetadata('schedule_snapshot_hash') !== hash) {
            throw new ScheduleRevisionConflictError(snapshot.revision);
          }
          this.setMetadata('schedule_generated_at', snapshot.generatedAt);
          return;
        }
      }

      this.database.exec('DELETE FROM schedules');
      const insert = this.database.prepare(`
        INSERT INTO schedules(
          schedule_id,
          time_local,
          days_of_week_json,
          timezone,
          portion_grams_cents,
          active,
          updated_at,
          deleted_at,
          snapshot_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const schedule of snapshot.items) {
        insert.run(
          schedule.scheduleId,
          schedule.timeLocal,
          JSON.stringify(schedule.daysOfWeek),
          schedule.timezone,
          gramsToCents(schedule.portionGrams),
          schedule.active ? 1 : 0,
          schedule.updatedAt,
          schedule.deletedAt,
          snapshot.revision,
        );
      }

      this.setMetadata('schedule_revision', String(snapshot.revision));
      this.setMetadata('schedule_generated_at', snapshot.generatedAt);
      this.setMetadata('schedule_snapshot_hash', hash);
    });
  }

  claimScheduleOccurrence(claim: ScheduleOccurrenceClaim): boolean {
    this.assertOpen();
    validateOccurrenceClaim(claim);

    return this.transaction(() => {
      const existingByKey = this.database.prepare(`
        SELECT schedule_id, feeding_id, scheduled_for
        FROM schedule_occurrences
        WHERE occurrence_key = ?
      `).get(claim.occurrenceKey);
      if (existingByKey) {
        if (
          readString(existingByKey, 'schedule_id') !== claim.scheduleId
          || readString(existingByKey, 'feeding_id') !== claim.feedingId
          || readString(existingByKey, 'scheduled_for') !== claim.scheduledFor
        ) {
          throw new ScheduleOccurrenceConflictError(claim.occurrenceKey);
        }
        return false;
      }

      const existingByFeeding = this.database.prepare(`
        SELECT occurrence_key FROM schedule_occurrences WHERE feeding_id = ?
      `).get(claim.feedingId);
      if (existingByFeeding) {
        throw new ScheduleOccurrenceConflictError(claim.feedingId);
      }

      this.database.prepare(`
        INSERT INTO schedule_occurrences(
          occurrence_key, schedule_id, feeding_id, scheduled_for, claimed_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        claim.occurrenceKey,
        claim.scheduleId,
        claim.feedingId,
        claim.scheduledFor,
        claim.claimedAt,
      );
      return true;
    });
  }

  enqueueOutbox(message: NewOutboxMessage): number {
    this.assertOpen();
    validateOutboxMessage(message);

    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT id, payload_json, created_at
        FROM outbox
        WHERE kind = ? AND aggregate_id = ?
      `).get(message.kind, message.aggregateId);
      if (existing) {
        if (
          readString(existing, 'payload_json') !== message.payload
          || readString(existing, 'created_at') !== message.createdAt
        ) {
          throw new OutboxConflictError(message.kind, message.aggregateId);
        }
        return readNumber(existing, 'id');
      }

      const result = this.database.prepare(`
        INSERT INTO outbox(
          kind, aggregate_id, payload_json, next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        message.kind,
        message.aggregateId,
        message.payload,
        message.nextAttemptAt,
        message.createdAt,
      );
      return sqliteIntegerToNumber(result.lastInsertRowid, 'outbox id');
    });
  }

  listPendingOutbox(limit: number, availableAt: UtcDateTime): OutboxMessage[] {
    this.assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('limit must be a positive safe integer');
    }
    const parsedAvailableAt = utcDateTimeSchema.parse(availableAt);
    const rows = this.database.prepare(`
      SELECT
        id,
        kind,
        aggregate_id,
        payload_json,
        attempt_count,
        next_attempt_at,
        last_error,
        created_at
      FROM outbox
      WHERE delivered_at IS NULL
        AND julianday(next_attempt_at) <= julianday(?)
      ORDER BY julianday(created_at), id
      LIMIT ?
    `).all(parsedAvailableAt, limit);
    return rows.map(readOutboxMessage);
  }

  rescheduleOutbox(id: number, nextAttemptAt: UtcDateTime, lastError: string): boolean {
    this.assertOpen();
    assertPositiveSafeInteger(id, 'id');
    const parsedNextAttemptAt = utcDateTimeSchema.parse(nextAttemptAt);
    if (lastError.trim().length === 0) throw new TypeError('lastError must not be blank');

    const result = this.database.prepare(`
      UPDATE outbox
      SET attempt_count = attempt_count + 1,
          next_attempt_at = ?,
          last_error = ?
      WHERE id = ? AND delivered_at IS NULL
    `).run(parsedNextAttemptAt, lastError, id);
    return sqliteIntegerToNumber(result.changes, 'changed row count') === 1;
  }

  markOutboxDelivered(id: number, deliveredAt: UtcDateTime): boolean {
    this.assertOpen();
    assertPositiveSafeInteger(id, 'id');
    const parsedDeliveredAt = utcDateTimeSchema.parse(deliveredAt);
    const result = this.database.prepare(`
      UPDATE outbox
      SET delivered_at = ?, last_error = NULL
      WHERE id = ? AND delivered_at IS NULL
    `).run(parsedDeliveredAt, id);
    return sqliteIntegerToNumber(result.changes, 'changed row count') === 1;
  }

  private transaction<T>(operation: () => T): T {
    if (this.database.isTransaction) {
      throw new Error('Nested local store transactions are not supported');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private getMetadata(key: string): string | undefined {
    const row = this.database.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
    return row ? readString(row, 'value') : undefined;
  }

  private requireMetadata(key: string): string {
    const value = this.getMetadata(key);
    if (value === undefined) throw new Error(`Missing local metadata: ${key}`);
    return value;
  }

  private setMetadata(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO metadata(key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }

  private assertOpen(): void {
    if (this.closed || !this.database.isOpen) throw new Error('Local store is closed');
  }
}

function validateSnapshot(snapshot: LocalScheduleSnapshot): void {
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new RangeError('Schedule revision must be a nonnegative safe integer');
  }
  utcDateTimeSchema.parse(snapshot.generatedAt);
  for (const schedule of snapshot.items) {
    scheduleIdSchema.parse(schedule.scheduleId);
    localTimeSchema.parse(schedule.timeLocal);
    daysOfWeekSchema.parse([...schedule.daysOfWeek]);
    timezoneSchema.parse(schedule.timezone);
    portionGramsSchema.parse(schedule.portionGrams);
    utcDateTimeSchema.parse(schedule.updatedAt);
    if (schedule.deletedAt !== null) utcDateTimeSchema.parse(schedule.deletedAt);
  }
}

function hashSnapshot(schedules: readonly LocalSchedule[]): string {
  const canonical = schedules
    .map((schedule) => ({
      scheduleId: schedule.scheduleId,
      timeLocal: schedule.timeLocal,
      daysOfWeek: [...schedule.daysOfWeek].sort(),
      timezone: schedule.timezone,
      portionGramsCents: gramsToCents(schedule.portionGrams),
      active: schedule.active,
      updatedAt: schedule.updatedAt,
      deletedAt: schedule.deletedAt,
    }))
    .sort((left, right) => left.scheduleId.localeCompare(right.scheduleId));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function readSchedule(row: Record<string, unknown>): LocalSchedule {
  const parsedDays: unknown = JSON.parse(readString(row, 'days_of_week_json'));
  const deletedAt = readNullableString(row, 'deleted_at');
  return {
    scheduleId: scheduleIdSchema.parse(readString(row, 'schedule_id')),
    timeLocal: localTimeSchema.parse(readString(row, 'time_local')),
    daysOfWeek: daysOfWeekSchema.parse(parsedDays),
    timezone: timezoneSchema.parse(readString(row, 'timezone')),
    portionGrams: portionGramsSchema.parse(readNumber(row, 'portion_grams_cents') / 100),
    active: readBooleanInteger(row, 'active'),
    updatedAt: utcDateTimeSchema.parse(readString(row, 'updated_at')),
    deletedAt: deletedAt === null ? null : utcDateTimeSchema.parse(deletedAt),
  };
}

function validateOccurrenceClaim(claim: ScheduleOccurrenceClaim): void {
  if (claim.occurrenceKey.trim().length === 0) {
    throw new TypeError('occurrenceKey must not be blank');
  }
  scheduleIdSchema.parse(claim.scheduleId);
  feedingIdSchema.parse(claim.feedingId);
  utcDateTimeSchema.parse(claim.scheduledFor);
  utcDateTimeSchema.parse(claim.claimedAt);
}

function validateOutboxMessage(message: NewOutboxMessage): void {
  if (!outboxKinds.has(message.kind)) throw new TypeError(`Unknown outbox kind: ${message.kind}`);
  if (message.aggregateId.trim().length === 0) throw new TypeError('aggregateId must not be blank');
  const payload: unknown = JSON.parse(message.payload);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new TypeError('Outbox payload must be a JSON object');
  }
  utcDateTimeSchema.parse(message.createdAt);
  utcDateTimeSchema.parse(message.nextAttemptAt);
}

function readOutboxMessage(row: Record<string, unknown>): OutboxMessage {
  const kind = readString(row, 'kind');
  if (!outboxKinds.has(kind as OutboxKind)) throw new Error(`Invalid outbox kind: ${kind}`);
  return {
    id: readNumber(row, 'id'),
    kind: kind as OutboxKind,
    aggregateId: readString(row, 'aggregate_id'),
    payload: readString(row, 'payload_json'),
    attemptCount: readNumber(row, 'attempt_count'),
    nextAttemptAt: utcDateTimeSchema.parse(readString(row, 'next_attempt_at')),
    lastError: readNullableString(row, 'last_error'),
    createdAt: utcDateTimeSchema.parse(readString(row, 'created_at')),
  };
}

function gramsToCents(grams: number): number {
  actualGramsSchema.parse(grams);
  const cents = Math.round(grams * 100);
  if (!Number.isSafeInteger(cents)) throw new RangeError('Gram value is not safely representable');
  return cents;
}

function readString(row: Record<string, unknown> | undefined, column: string): string {
  const value = row?.[column];
  if (typeof value !== 'string') throw new Error(`Expected string column ${column}`);
  return value;
}

function readNullableString(
  row: Record<string, unknown> | undefined,
  column: string,
): string | null {
  const value = row?.[column];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`Expected nullable string column ${column}`);
  return value;
}

function readNumber(row: Record<string, unknown> | undefined, column: string): number {
  const value = row?.[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Expected safe integer column ${column}`);
  }
  return value;
}

function readBooleanInteger(row: Record<string, unknown>, column: string): boolean {
  const value = readNumber(row, column);
  if (value !== 0 && value !== 1) throw new Error(`Expected boolean column ${column}`);
  return value === 1;
}

function sqliteIntegerToNumber(value: number | bigint, description: string): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(numeric)) throw new Error(`Invalid ${description}`);
  return numeric;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
