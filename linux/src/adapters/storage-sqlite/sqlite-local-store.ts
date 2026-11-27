import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  reportDeviceStateRequestSchema,
  type ReportDeviceStateRequest,
} from '../../contracts/index.js';
import {
  actualGramsSchema,
  commandIdSchema,
  daysOfWeekSchema,
  errorCodeSchema,
  errorMessageSchema,
  feedingIdSchema,
  localTimeSchema,
  portionGramsSchema,
  scheduleIdSchema,
  timezoneSchema,
  utcDateTimeSchema,
  type CommandId,
  type FeedingId,
  type UtcDateTime,
} from '../../domain/index.js';
import {
  FeedingIntentConflictError,
  FeedingStateConflictError,
  HeartbeatPayloadConflictError,
  ManualCommandConflictError,
  NonMonotonicHeartbeatError,
  OutboxConflictError,
  ScheduleOccurrenceConflictError,
  ScheduleRevisionConflictError,
  StaleScheduleRevisionError,
  type FeedingCompletion,
  type FeedingIntent,
  type HeartbeatDeliveryReceipt,
  type LocalSchedule,
  type LocalScheduleSnapshot,
  type LocalStore,
  type ManualCommand,
  type NewOutboxMessage,
  type OutboxKind,
  type OutboxMessage,
  type ScheduleOccurrenceClaim,
  type StoredLocalFeeding,
  type StoredHeartbeat,
} from '../../ports/index.js';
import { runMigrations } from './migration-runner.js';
import { ProcessLock } from './process-lock.js';

const defaultMigrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../migrations',
);
const outboxKinds = new Set<OutboxKind>(['state', 'ack', 'manual_result', 'scheduled_event']);
const feedingStatuses: ReadonlySet<StoredLocalFeeding['status']> = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'expired',
]);

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

  getLastHeartbeat(): StoredHeartbeat | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT
        status,
        reported_at,
        firmware_version,
        error_code,
        error_message,
        delivery_state,
        server_time,
        clock_offset_ms,
        request_id
      FROM device_state
      WHERE singleton_id = 1
    `).get();
    return row ? readHeartbeat(row) : null;
  }

  savePendingHeartbeat(payload: ReportDeviceStateRequest): void {
    this.assertOpen();
    const validated = reportDeviceStateRequestSchema.parse(payload);

    this.transaction(() => {
      const existing = this.getLastHeartbeat();
      if (existing) {
        const existingTime = Date.parse(existing.payload.reported_at);
        const nextTime = Date.parse(validated.reported_at);
        if (nextTime < existingTime) throw new NonMonotonicHeartbeatError();
        if (nextTime === existingTime) {
          if (!heartbeatPayloadEquals(existing.payload, validated)) {
            throw new HeartbeatPayloadConflictError();
          }
          return;
        }
      }

      this.database.prepare(`
        INSERT INTO device_state(
          singleton_id,
          status,
          reported_at,
          firmware_version,
          error_code,
          error_message,
          delivery_state,
          server_time,
          clock_offset_ms,
          request_id
        ) VALUES (1, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)
        ON CONFLICT(singleton_id) DO UPDATE SET
          status = excluded.status,
          reported_at = excluded.reported_at,
          firmware_version = excluded.firmware_version,
          error_code = excluded.error_code,
          error_message = excluded.error_message,
          delivery_state = 'pending',
          server_time = NULL,
          clock_offset_ms = NULL,
          request_id = NULL
      `).run(
        validated.status,
        validated.reported_at,
        validated.firmware_version,
        validated.error_code,
        validated.error_message,
      );
    });
  }

  markHeartbeatDelivered(receipt: HeartbeatDeliveryReceipt): boolean {
    this.assertOpen();
    const reportedAt = utcDateTimeSchema.parse(receipt.reportedAt);
    const serverTime = utcDateTimeSchema.parse(receipt.serverTime);
    if (!Number.isSafeInteger(receipt.clockOffsetMs)) {
      throw new RangeError('clockOffsetMs must be a safe integer');
    }
    if (receipt.requestId !== null && receipt.requestId.trim().length === 0) {
      throw new TypeError('requestId must be null or a nonblank string');
    }

    const result = this.database.prepare(`
      UPDATE device_state
      SET delivery_state = 'delivered',
          server_time = ?,
          clock_offset_ms = ?,
          request_id = ?
      WHERE singleton_id = 1
        AND reported_at = ?
        AND delivery_state = 'pending'
    `).run(serverTime, receipt.clockOffsetMs, receipt.requestId, reportedAt);
    return sqliteIntegerToNumber(result.changes, 'changed row count') === 1;
  }

  getManualCommand(commandId: CommandId): ManualCommand | null {
    this.assertOpen();
    const validatedCommandId = commandIdSchema.parse(commandId);
    const row = this.database.prepare(`
      SELECT command_id, feeding_id, created_at, expires_at,
             json_extract(payload_json, '$.portion_grams') AS portion_grams
      FROM commands
      WHERE command_id = ?
    `).get(validatedCommandId);
    return row ? readManualCommand(row) : null;
  }

  getNextManualCommand(serverNow: UtcDateTime): ManualCommand | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT command_id, feeding_id, created_at, expires_at,
             json_extract(payload_json, '$.portion_grams') AS portion_grams
      FROM commands
      WHERE phase = 'received' AND julianday(expires_at) > julianday(?)
      ORDER BY julianday(created_at), command_id
      LIMIT 1
    `).get(utcDateTimeSchema.parse(serverNow));
    return row ? readManualCommand(row) : null;
  }

  recordManualCommand(command: ManualCommand): boolean {
    this.assertOpen();
    const commandId = commandIdSchema.parse(command.commandId);
    const feedingId = feedingIdSchema.parse(command.feedingId);
    const portionGrams = portionGramsSchema.parse(command.portionGrams);
    const createdAt = utcDateTimeSchema.parse(command.createdAt);
    const expiresAt = utcDateTimeSchema.parse(command.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
      throw new TypeError('Command expiration must be later than creation time');
    }
    const payload = JSON.stringify({
      command_id: commandId,
      feeding_id: feedingId,
      portion_grams: portionGrams,
      created_at: createdAt,
      expires_at: expiresAt,
    });
    const fingerprint = createHash('sha256').update(payload).digest('hex');

    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT command_id, fingerprint FROM commands
        WHERE command_id = ? OR feeding_id = ?
      `).get(commandId, feedingId);
      if (existing) {
        if (
          readString(existing, 'command_id') !== commandId
          || readString(existing, 'fingerprint') !== fingerprint
        ) {
          throw new ManualCommandConflictError(commandId);
        }
        return false;
      }

      this.database.prepare(`
        INSERT INTO commands(
          command_id, feeding_id, fingerprint, payload_json, expires_at, phase, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'received', ?, ?)
      `).run(commandId, feedingId, fingerprint, payload, expiresAt, createdAt, new Date().toISOString());
      return true;
    });
  }

  getFeeding(feedingId: FeedingId): StoredLocalFeeding | null {
    this.assertOpen();
    const validatedFeedingId = feedingIdSchema.parse(feedingId);
    const row = this.database.prepare(`
      SELECT
        feeding_id,
        source,
        command_id,
        schedule_id,
        portion_grams_cents,
        actual_grams_cents,
        status,
        created_at,
        started_at,
        finished_at,
        error_code,
        error_message,
        terminal_payload_json
      FROM feedings
      WHERE feeding_id = ?
    `).get(validatedFeedingId);
    return row ? readFeeding(row) : null;
  }

  recordFeedingIntent(intent: FeedingIntent): boolean {
    this.assertOpen();
    validateFeedingIntent(intent);
    return this.transaction(() => {
      const existing = this.getFeeding(intent.feedingId);
      if (existing) {
        if (!feedingIntentEquals(existing, intent)) {
          throw new FeedingIntentConflictError(intent.feedingId);
        }
        return false;
      }
      this.database.prepare(`
        INSERT INTO feedings(
          feeding_id,
          source,
          command_id,
          schedule_id,
          portion_grams_cents,
          status,
          created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        intent.feedingId,
        intent.source,
        intent.commandId,
        intent.scheduleId,
        gramsToCents(intent.portionGrams),
        intent.createdAt,
      );
      return true;
    });
  }

  markFeedingRunning(
    feedingId: FeedingId,
    startedAt: UtcDateTime,
  ): boolean {
    this.assertOpen();
    const validatedFeedingId = feedingIdSchema.parse(feedingId);
    const validatedStartedAt = utcDateTimeSchema.parse(startedAt);
    return this.transaction(() => {
      const existing = this.getFeeding(validatedFeedingId);
      if (!existing) throw new FeedingStateConflictError(validatedFeedingId);
      if (existing.status === 'running' && existing.startedAt === validatedStartedAt) return false;
      if (existing.status !== 'pending') throw new FeedingStateConflictError(validatedFeedingId);
      if (Date.parse(validatedStartedAt) < Date.parse(existing.createdAt)) {
        throw new FeedingStateConflictError(validatedFeedingId);
      }
      const result = this.database.prepare(`
        UPDATE feedings
        SET status = 'running', started_at = ?
        WHERE feeding_id = ? AND status = 'pending'
      `).run(validatedStartedAt, validatedFeedingId);
      if (sqliteIntegerToNumber(result.changes, 'changed row count') !== 1) {
        throw new FeedingStateConflictError(validatedFeedingId);
      }
      return true;
    });
  }

  completeFeedingAndEnqueue(
    completion: FeedingCompletion,
    outbox: NewOutboxMessage,
  ): number {
    this.assertOpen();
    validateFeedingCompletion(completion);
    validateOutboxMessage(outbox);
    if (
      outbox.aggregateId !== completion.feedingId
      || outbox.payload !== completion.terminalPayload
      || outbox.createdAt !== completion.finishedAt
    ) {
      throw new TypeError('Terminal outbox must contain the exact feeding payload and timestamp');
    }

    return this.transaction(() => {
      const existing = this.getFeeding(completion.feedingId);
      if (!existing) throw new FeedingStateConflictError(completion.feedingId);
      const expectedKind: OutboxKind = existing.source === 'manual'
        ? 'manual_result'
        : 'scheduled_event';
      if (outbox.kind !== expectedKind) {
        throw new TypeError(`Expected ${expectedKind} outbox message`);
      }
      if (existing.status === 'completed' || existing.status === 'failed') {
        if (!feedingCompletionEquals(existing, completion)) {
          throw new FeedingStateConflictError(completion.feedingId);
        }
        return this.enqueueOutboxWithinTransaction(outbox);
      }
      if (existing.status !== 'running' || existing.startedAt !== completion.startedAt) {
        throw new FeedingStateConflictError(completion.feedingId);
      }

      const result = this.database.prepare(`
        UPDATE feedings
        SET status = ?,
            actual_grams_cents = ?,
            finished_at = ?,
            error_code = ?,
            error_message = ?,
            terminal_payload_json = ?
        WHERE feeding_id = ? AND status = 'running' AND started_at = ?
      `).run(
        completion.status,
        completion.actualGrams === null ? null : gramsToCents(completion.actualGrams),
        completion.finishedAt,
        completion.errorCode,
        completion.errorMessage,
        completion.terminalPayload,
        completion.feedingId,
        completion.startedAt,
      );
      if (sqliteIntegerToNumber(result.changes, 'changed row count') !== 1) {
        throw new FeedingStateConflictError(completion.feedingId);
      }
      return this.enqueueOutboxWithinTransaction(outbox);
    });
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

  getScheduleOccurrence(occurrenceKey: string): ScheduleOccurrenceClaim | null {
    this.assertOpen();
    if (occurrenceKey.trim().length === 0) throw new TypeError('occurrenceKey must not be blank');
    const row = this.database.prepare(`
      SELECT occurrence_key, schedule_id, feeding_id, scheduled_for, claimed_at
      FROM schedule_occurrences
      WHERE occurrence_key = ?
    `).get(occurrenceKey);
    if (!row) return null;
    return {
      occurrenceKey: readString(row, 'occurrence_key'),
      scheduleId: scheduleIdSchema.parse(readString(row, 'schedule_id')),
      feedingId: feedingIdSchema.parse(readString(row, 'feeding_id')),
      scheduledFor: utcDateTimeSchema.parse(readString(row, 'scheduled_for')),
      claimedAt: utcDateTimeSchema.parse(readString(row, 'claimed_at')),
    };
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

    return this.transaction(() => this.enqueueOutboxWithinTransaction(message));
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

  private enqueueOutboxWithinTransaction(message: NewOutboxMessage): number {
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

function readHeartbeat(row: Record<string, unknown>): StoredHeartbeat {
  const serverTime = readNullableString(row, 'server_time');
  const deliveryState = readString(row, 'delivery_state');
  if (deliveryState !== 'pending' && deliveryState !== 'delivered') {
    throw new Error(`Invalid heartbeat delivery state: ${deliveryState}`);
  }
  return {
    payload: reportDeviceStateRequestSchema.parse({
      status: readString(row, 'status'),
      reported_at: readString(row, 'reported_at'),
      firmware_version: readString(row, 'firmware_version'),
      error_code: readNullableString(row, 'error_code'),
      error_message: readNullableString(row, 'error_message'),
    }),
    deliveryState,
    serverTime: serverTime === null ? null : utcDateTimeSchema.parse(serverTime),
    clockOffsetMs: readNullableNumber(row, 'clock_offset_ms'),
    requestId: readNullableString(row, 'request_id'),
  };
}

function heartbeatPayloadEquals(
  left: ReportDeviceStateRequest,
  right: ReportDeviceStateRequest,
): boolean {
  return left.status === right.status
    && left.reported_at === right.reported_at
    && left.firmware_version === right.firmware_version
    && left.error_code === right.error_code
    && left.error_message === right.error_message;
}

function readManualCommand(row: Record<string, unknown>): ManualCommand {
  return {
    commandId: commandIdSchema.parse(readString(row, 'command_id')),
    feedingId: feedingIdSchema.parse(readString(row, 'feeding_id')),
    portionGrams: portionGramsSchema.parse(row.portion_grams),
    createdAt: utcDateTimeSchema.parse(readString(row, 'created_at')),
    expiresAt: utcDateTimeSchema.parse(readString(row, 'expires_at')),
  };
}

function validateFeedingIntent(intent: FeedingIntent): void {
  feedingIdSchema.parse(intent.feedingId);
  portionGramsSchema.parse(intent.portionGrams);
  utcDateTimeSchema.parse(intent.createdAt);
  if (intent.source === 'manual') {
    commandIdSchema.parse(intent.commandId);
    if (intent.scheduleId !== null) throw new TypeError('Manual feeding cannot reference scheduleId');
  } else {
    scheduleIdSchema.parse(intent.scheduleId);
    if (intent.commandId !== null) throw new TypeError('Scheduled feeding cannot reference commandId');
  }
}

function validateFeedingCompletion(completion: FeedingCompletion): void {
  feedingIdSchema.parse(completion.feedingId);
  utcDateTimeSchema.parse(completion.startedAt);
  utcDateTimeSchema.parse(completion.finishedAt);
  if (Date.parse(completion.finishedAt) < Date.parse(completion.startedAt)) {
    throw new TypeError('Feeding finishedAt must not precede startedAt');
  }
  const payload: unknown = JSON.parse(completion.terminalPayload);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new TypeError('Terminal payload must be a JSON object');
  }
  if (completion.status === 'completed') {
    actualGramsSchema.parse(completion.actualGrams);
    if (completion.errorCode !== null || completion.errorMessage !== null) {
      throw new TypeError('Completed feeding cannot contain error details');
    }
  } else {
    if (completion.actualGrams !== null) actualGramsSchema.parse(completion.actualGrams);
    errorCodeSchema.parse(completion.errorCode);
    errorMessageSchema.parse(completion.errorMessage);
  }
}

function readFeeding(row: Record<string, unknown>): StoredLocalFeeding {
  const source = readString(row, 'source');
  const status = readString(row, 'status');
  if (source !== 'manual' && source !== 'scheduled') {
    throw new Error(`Invalid feeding source: ${source}`);
  }
  if (!feedingStatuses.has(status as StoredLocalFeeding['status'])) {
    throw new Error(`Invalid feeding status: ${status}`);
  }
  const actualCents = readNullableNumber(row, 'actual_grams_cents');
  const common = {
    feedingId: feedingIdSchema.parse(readString(row, 'feeding_id')),
    portionGrams: portionGramsSchema.parse(readNumber(row, 'portion_grams_cents') / 100),
    createdAt: utcDateTimeSchema.parse(readString(row, 'created_at')),
    status: status as StoredLocalFeeding['status'],
    actualGrams: actualCents === null ? null : actualGramsSchema.parse(actualCents / 100),
    startedAt: parseNullableUtc(row, 'started_at'),
    finishedAt: parseNullableUtc(row, 'finished_at'),
    errorCode: parseNullableErrorCode(row, 'error_code'),
    errorMessage: parseNullableErrorMessage(row, 'error_message'),
    terminalPayload: readNullableString(row, 'terminal_payload_json'),
  };
  if (source === 'manual') {
    return {
      ...common,
      source,
      commandId: commandIdSchema.parse(readString(row, 'command_id')),
      scheduleId: null,
    };
  }
  return {
    ...common,
    source,
    commandId: null,
    scheduleId: scheduleIdSchema.parse(readString(row, 'schedule_id')),
  };
}

function feedingIntentEquals(existing: StoredLocalFeeding, intent: FeedingIntent): boolean {
  return existing.feedingId === intent.feedingId
    && existing.source === intent.source
    && existing.commandId === intent.commandId
    && existing.scheduleId === intent.scheduleId
    && existing.portionGrams === intent.portionGrams
    && existing.createdAt === intent.createdAt;
}

function feedingCompletionEquals(
  existing: StoredLocalFeeding,
  completion: FeedingCompletion,
): boolean {
  return existing.feedingId === completion.feedingId
    && existing.status === completion.status
    && existing.actualGrams === completion.actualGrams
    && existing.startedAt === completion.startedAt
    && existing.finishedAt === completion.finishedAt
    && existing.errorCode === completion.errorCode
    && existing.errorMessage === completion.errorMessage
    && existing.terminalPayload === completion.terminalPayload;
}

function parseNullableUtc(row: Record<string, unknown>, column: string): UtcDateTime | null {
  const value = readNullableString(row, column);
  return value === null ? null : utcDateTimeSchema.parse(value);
}

function parseNullableErrorCode(row: Record<string, unknown>, column: string): string | null {
  const value = readNullableString(row, column);
  return value === null ? null : errorCodeSchema.parse(value);
}

function parseNullableErrorMessage(row: Record<string, unknown>, column: string): string | null {
  const value = readNullableString(row, column);
  return value === null ? null : errorMessageSchema.parse(value);
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

function readNullableNumber(
  row: Record<string, unknown> | undefined,
  column: string,
): number | null {
  const value = row?.[column];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Expected nullable safe integer column ${column}`);
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
