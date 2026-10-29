import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SqliteLocalStore } from '../../src/adapters/storage-sqlite/index.js';
import {
  daysOfWeekSchema,
  feedingIdSchema,
  scheduleIdSchema,
  utcDateTimeSchema,
} from '../../src/domain/index.js';
import {
  LocalStoreLockedError,
  OutboxConflictError,
  ScheduleOccurrenceConflictError,
  ScheduleRevisionConflictError,
  StaleScheduleRevisionError,
  type LocalSchedule,
  type LocalScheduleSnapshot,
} from '../../src/ports/index.js';

const firstScheduleId = scheduleIdSchema.parse('36ee8225-cd00-46ea-b6ef-db9e66c0946b');
const secondScheduleId = scheduleIdSchema.parse('811f98b6-e0f9-40ad-9b5e-46d501f1a1d3');
const firstFeedingId = feedingIdSchema.parse('b01f6503-fad1-4d5d-b734-864159d9b1e6');
const secondFeedingId = feedingIdSchema.parse('a552a367-1de4-4381-a238-d93f1f1da654');
const initialMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations/001_initial.sql',
);

test('SQLite store applies migrations and enforces a single process lock', (t) => {
  const databasePath = temporaryDatabasePath(t);
  const store = SqliteLocalStore.open({ databasePath });

  assert.equal(store.getSchemaVersion(), 1);
  assert.throws(
    () => SqliteLocalStore.open({ databasePath }),
    LocalStoreLockedError,
  );

  store.close();
  const reopened = SqliteLocalStore.open({ databasePath });
  assert.equal(reopened.getSchemaVersion(), 1);
  reopened.close();
});

test('SQLite store rejects a modified applied migration and releases its lock', (t) => {
  const directory = temporaryDirectory(t);
  const databasePath = join(directory, 'device.sqlite');
  const migrationsDirectory = join(directory, 'migrations');
  const copiedMigration = join(migrationsDirectory, '001_initial.sql');
  mkdirSync(migrationsDirectory);
  copyFileSync(initialMigrationPath, copiedMigration);

  const store = SqliteLocalStore.open({ databasePath, migrationsDirectory });
  store.close();

  appendFileSync(copiedMigration, '\n-- modified\n', 'utf8');
  assert.throws(
    () => SqliteLocalStore.open({ databasePath, migrationsDirectory }),
    /Applied migration 1 was modified/,
  );

  copyFileSync(initialMigrationPath, copiedMigration);
  const reopened = SqliteLocalStore.open({ databasePath, migrationsDirectory });
  reopened.close();
});

test('schedule snapshot is atomically replaced and survives restart', (t) => {
  const databasePath = temporaryDatabasePath(t);
  const snapshot = scheduleSnapshot(12, [
    schedule(firstScheduleId, 45.5),
    schedule(secondScheduleId, 30, '2026-10-29T08:10:00Z'),
  ]);

  const store = SqliteLocalStore.open({ databasePath });
  assert.equal(store.getScheduleSnapshot(), null);
  store.replaceScheduleSnapshot(snapshot);
  assert.deepEqual(store.getScheduleSnapshot(), snapshot);
  store.close();

  const reopened = SqliteLocalStore.open({ databasePath });
  assert.deepEqual(reopened.getScheduleSnapshot(), snapshot);
  reopened.close();
});

test('schedule revision conflicts and failed replacement preserve the last snapshot', (t) => {
  const databasePath = temporaryDatabasePath(t);
  const store = SqliteLocalStore.open({ databasePath });
  const current = scheduleSnapshot(12, [schedule(firstScheduleId, 45.5)]);
  store.replaceScheduleSnapshot(current);

  assert.throws(
    () => store.replaceScheduleSnapshot(scheduleSnapshot(11, current.items)),
    StaleScheduleRevisionError,
  );
  assert.throws(
    () => store.replaceScheduleSnapshot(scheduleSnapshot(12, [schedule(firstScheduleId, 50)])),
    ScheduleRevisionConflictError,
  );

  const duplicateIds = scheduleSnapshot(13, [
    schedule(firstScheduleId, 45.5),
    schedule(firstScheduleId, 50),
  ]);
  assert.throws(() => store.replaceScheduleSnapshot(duplicateIds));
  assert.deepEqual(store.getScheduleSnapshot(), current);
  store.close();
});

test('schedule occurrence claim is durable and rejects conflicting identities', (t) => {
  const databasePath = temporaryDatabasePath(t);
  const claim = {
    occurrenceKey: `${firstScheduleId}:2026-10-29:08:30:00`,
    scheduleId: firstScheduleId,
    feedingId: firstFeedingId,
    scheduledFor: utcDateTimeSchema.parse('2026-10-29T08:30:00Z'),
    claimedAt: utcDateTimeSchema.parse('2026-10-29T08:29:59Z'),
  };

  const store = SqliteLocalStore.open({ databasePath });
  assert.equal(store.claimScheduleOccurrence(claim), true);
  assert.equal(store.claimScheduleOccurrence(claim), false);
  assert.throws(
    () => store.claimScheduleOccurrence({ ...claim, feedingId: secondFeedingId }),
    ScheduleOccurrenceConflictError,
  );
  assert.throws(
    () => store.claimScheduleOccurrence({ ...claim, occurrenceKey: 'another-occurrence' }),
    ScheduleOccurrenceConflictError,
  );
  store.close();

  const reopened = SqliteLocalStore.open({ databasePath });
  assert.equal(reopened.claimScheduleOccurrence(claim), false);
  reopened.close();
});

test('outbox preserves exact payload and durable retry state', (t) => {
  const databasePath = temporaryDatabasePath(t);
  const store = SqliteLocalStore.open({ databasePath });
  const message = {
    kind: 'scheduled_event' as const,
    aggregateId: firstFeedingId,
    payload: '{"feeding_id":"b01f6503-fad1-4d5d-b734-864159d9b1e6","status":"completed"}',
    createdAt: utcDateTimeSchema.parse('2026-10-29T08:30:08Z'),
    nextAttemptAt: utcDateTimeSchema.parse('2026-10-29T08:30:08Z'),
  };

  const id = store.enqueueOutbox(message);
  assert.equal(store.enqueueOutbox(message), id);
  assert.throws(
    () => store.enqueueOutbox({ ...message, payload: '{"status":"failed"}' }),
    OutboxConflictError,
  );
  assert.deepEqual(
    store.listPendingOutbox(10, utcDateTimeSchema.parse('2026-10-29T08:30:07Z')),
    [],
  );

  const pending = store.listPendingOutbox(
    10,
    utcDateTimeSchema.parse('2026-10-29T08:30:08Z'),
  );
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.payload, message.payload);
  assert.equal(pending[0]?.attemptCount, 0);

  assert.equal(store.rescheduleOutbox(
    id,
    utcDateTimeSchema.parse('2026-10-29T08:31:00Z'),
    'Backend unavailable',
  ), true);
  assert.deepEqual(
    store.listPendingOutbox(10, utcDateTimeSchema.parse('2026-10-29T08:30:59Z')),
    [],
  );
  const retried = store.listPendingOutbox(
    10,
    utcDateTimeSchema.parse('2026-10-29T08:31:00Z'),
  );
  assert.equal(retried[0]?.attemptCount, 1);
  assert.equal(retried[0]?.lastError, 'Backend unavailable');

  assert.equal(store.markOutboxDelivered(
    id,
    utcDateTimeSchema.parse('2026-10-29T08:31:01Z'),
  ), true);
  assert.equal(store.markOutboxDelivered(
    id,
    utcDateTimeSchema.parse('2026-10-29T08:31:02Z'),
  ), false);
  assert.deepEqual(
    store.listPendingOutbox(10, utcDateTimeSchema.parse('2026-10-29T09:00:00Z')),
    [],
  );
  store.close();
});

function temporaryDatabasePath(t: TestContext): string {
  return join(temporaryDirectory(t), 'device.sqlite');
}

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'smart-cat-feeder-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function schedule(
  scheduleId: typeof firstScheduleId,
  portionGrams: number,
  deletedAt: string | null = null,
): LocalSchedule {
  return {
    scheduleId,
    timeLocal: '08:30:00',
    daysOfWeek: daysOfWeekSchema.parse(['mon', 'wed', 'fri']),
    timezone: 'Asia/Vladivostok',
    portionGrams,
    active: deletedAt === null,
    updatedAt: utcDateTimeSchema.parse('2026-10-29T08:00:00Z'),
    deletedAt: deletedAt === null ? null : utcDateTimeSchema.parse(deletedAt),
  };
}

function scheduleSnapshot(
  revision: number,
  items: readonly LocalSchedule[],
): LocalScheduleSnapshot {
  return {
    revision,
    generatedAt: utcDateTimeSchema.parse('2026-10-29T08:15:31Z'),
    items,
  };
}
