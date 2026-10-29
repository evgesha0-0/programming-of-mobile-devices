import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { loadMigrations, runMigrations, type Migration, type MigrationConnection } from '../src/db/migrations.js';
import { createDeviceRepository, type QueryExecutor } from '../src/devices/device.repository.js';
import { createScheduleRepository, type TransactionClient, type TransactionPool } from '../src/schedules/schedule.repository.js';

function client(db: PGlite): MigrationConnection {
  return {
    async query(sql, values) {
      if (values || sql.trimStart().startsWith('SELECT')) return db.query<Record<string, unknown>>(sql, values);
      await db.exec(sql);
      return { rows: [] };
    },
  };
}

function migration(name: string, sql: string): Migration {
  return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}

async function device(db: PGlite): Promise<string> {
  const id = randomUUID();
  await db.query('INSERT INTO devices(device_id, name) VALUES ($1, $2)', [id, 'Кормушка']);
  return id;
}

async function schedule(db: PGlite, deviceId: string, days = ['mon', 'wed'], portion: unknown = 40, revision = 1): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO schedules(schedule_id, device_id, time_local, days_of_week, timezone, portion_grams, revision)
    VALUES ($1, $2, '08:30:00', $3, 'Europe/Moscow', $4, $5)`, [id, deviceId, days, portion, revision]);
  return id;
}

async function command(db: PGlite, deviceId: string): Promise<{ commandId: string; feedingId: string }> {
  const commandId = randomUUID();
  const feedingId = randomUUID();
  await db.query(`INSERT INTO feeding_commands(command_id, feeding_id, device_id, portion_grams, created_at, expires_at)
    VALUES ($1, $2, $3, 40, '2026-10-25T12:00:00Z', '2026-10-25T12:05:00Z')`, [commandId, feedingId, deviceId]);
  return { commandId, feedingId };
}

test('initial migration creates tables, and the second run preserves existing data', async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  assert.deepEqual(await runMigrations(client(db)), ['001_initial_schema.sql']);
  const id = await device(db);
  assert.deepEqual(await runMigrations(client(db)), []);
  assert.equal((await db.query('SELECT * FROM devices WHERE device_id = $1', [id])).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length, 1);
});

test('changed or missing applied migration is rejected without changing the database', async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  const migrations = await loadMigrations();
  await runMigrations(client(db), migrations);
  await assert.rejects(runMigrations(client(db), [migration('001_initial_schema.sql', 'SELECT 1')]), /history differs/);
  await assert.rejects(runMigrations(client(db), []), /history differs/);
  assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length, 1);
});

test('failure rolls back all pending migrations and journal entries in the batch', async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  const base = await loadMigrations();
  await runMigrations(client(db), base);
  const next = migration('002_example.sql', 'CREATE TABLE migration_probe (id integer)');
  const broken = migration('003_broken.sql', 'INSERT INTO missing_table VALUES (1)');
  await assert.rejects(runMigrations(client(db), [...base, next, broken]), /missing_table/);
  assert.equal((await db.query<{ name: string | null }>("SELECT to_regclass('migration_probe') AS name")).rows[0]?.name, null);
  assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length, 1);
  assert.deepEqual(await runMigrations(client(db), [...base, next]), ['002_example.sql']);
});

test('migration loader normalizes Windows line endings and rejects duplicate versions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feeder-migrations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const url = pathToFileURL(directory + '/');
  await writeFile(join(directory, '001_test.sql'), 'SELECT 1;\r\n');
  const windows = await loadMigrations(url);
  await writeFile(join(directory, '001_test.sql'), 'SELECT 1;\n');
  assert.equal(windows[0]?.checksum, (await loadMigrations(url))[0]?.checksum);
  await writeFile(join(directory, '001_other.sql'), 'SELECT 2;');
  await assert.rejects(loadMigrations(url), /Duplicate migration version/);
});

test('migration loader refuses an empty directory and an unversioned SQL file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feeder-migrations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const url = pathToFileURL(directory + '/');
  await assert.rejects(loadMigrations(url), /No SQL migrations/);
  await writeFile(join(directory, 'initial.sql'), 'SELECT 1;');
  await assert.rejects(loadMigrations(url), /Invalid migration filename/);
});

test('schedules reject invalid days, nonpositive portions, NaN, and duplicate revisions', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const id = await device(db);
  for (const days of [[], ['mon', 'mon'], ['bad'], ['mon', null]]) {
    await assert.rejects(schedule(db, id, days as string[]));
  }
  for (const portion of [0, -1, 'NaN']) await assert.rejects(schedule(db, id, ['mon'], portion));
  await schedule(db, id);
  await assert.rejects(schedule(db, id), /unique/);
  await db.query('UPDATE schedules SET deleted_at = now() WHERE device_id = $1', [id]);
  assert.equal((await db.query('SELECT * FROM schedules WHERE device_id = $1', [id])).rows.length, 1);
});

test('manual command identity is unique and immutable, and statuses cannot go backwards', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const id = await device(db);
  const { commandId, feedingId } = await command(db, id);
  await assert.rejects(db.query(`INSERT INTO feeding_commands(command_id, feeding_id, device_id, portion_grams, expires_at)
    VALUES ($1, $2, $3, 40, now() + interval '5 minutes')`, [commandId, feedingId, id]), /unique/);
  await assert.rejects(db.query('UPDATE feeding_commands SET portion_grams = 50 WHERE command_id = $1', [commandId]), /cannot be changed/);
  await assert.rejects(db.query("UPDATE feeding_commands SET status = 'completed' WHERE command_id = $1", [commandId]), /transition/);
  await db.query("UPDATE feeding_commands SET status = 'running', started_at = '2026-10-25T12:01:00Z' WHERE command_id = $1", [commandId]);
  await assert.rejects(db.query("UPDATE feeding_commands SET status = 'pending' WHERE command_id = $1", [commandId]), /transition/);
  await db.query("UPDATE feeding_commands SET status = 'completed', finished_at = '2026-10-25T12:01:20Z' WHERE command_id = $1", [commandId]);
  await assert.rejects(db.query("UPDATE feeding_commands SET status = 'running' WHERE command_id = $1", [commandId]), /transition/);
});

test('manual commands require valid expiry, start time and terminal finish time', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const id = await device(db);
  await assert.rejects(db.query(`INSERT INTO feeding_commands(command_id, feeding_id, device_id, portion_grams, created_at, expires_at)
    VALUES ($1, $2, $3, 40, '2026-10-25T12:00:00Z', '2026-10-25T12:00:00Z')`, [randomUUID(), randomUUID(), id]));
  const { commandId } = await command(db, id);
  await assert.rejects(db.query("UPDATE feeding_commands SET status = 'running' WHERE command_id = $1", [commandId]));
  await assert.rejects(db.query("UPDATE feeding_commands SET status = 'expired' WHERE command_id = $1", [commandId]));
  await db.query("UPDATE feeding_commands SET status = 'expired', finished_at = '2026-10-25T12:05:00Z' WHERE command_id = $1", [commandId]);
  await assert.rejects(db.query("UPDATE feeding_commands SET status = 'running', started_at = '2026-10-25T12:06:00Z' WHERE command_id = $1", [commandId]), /transition/);
});

test('a feeding cannot reference another device schedule or another manual result ID', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const first = await device(db); const second = await device(db);
  const scheduleId = await schedule(db, first);
  await assert.rejects(db.query(`INSERT INTO feedings(feeding_id, device_id, schedule_id, source, portion_grams, status)
    VALUES ($1, $2, $3, 'scheduled', 40, 'pending')`, [randomUUID(), second, scheduleId]), /foreign key/);
  const { commandId, feedingId } = await command(db, first);
  await assert.rejects(db.query(`INSERT INTO feedings(feeding_id, device_id, command_id, source, portion_grams, status)
    VALUES ($1, $2, $3, 'manual', 40, 'pending')`, [randomUUID(), first, commandId]), /foreign key/);
  await db.query(`INSERT INTO feedings(feeding_id, device_id, command_id, source, portion_grams, status)
    VALUES ($1, $2, $3, 'manual', 40, 'pending')`, [feedingId, first, commandId]);
});

test('completed feeding requires weight and finish time, with history linked to soft-deleted schedules', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const deviceId = await device(db); const scheduleId = await schedule(db, deviceId);
  const feedingId = randomUUID();
  const insert = `INSERT INTO feedings(feeding_id, device_id, schedule_id, source, portion_grams, status, actual_grams, finished_at)
    VALUES ($1, $2, $3, 'scheduled', 40, 'completed', $4, $5)`;
  await assert.rejects(db.query(insert, [feedingId, deviceId, scheduleId, null, new Date()]));
  await assert.rejects(db.query(insert, [feedingId, deviceId, scheduleId, 39.5, null]));
  await assert.rejects(db.query(insert, [feedingId, deviceId, scheduleId, -1, new Date()]));
  await db.query(insert, [feedingId, deviceId, scheduleId, 39.5, new Date()]);
  await db.query('UPDATE schedules SET deleted_at = now() WHERE schedule_id = $1', [scheduleId]);
  assert.equal((await db.query('SELECT * FROM feedings WHERE feeding_id = $1', [feedingId])).rows.length, 1);
  await assert.rejects(db.query('DELETE FROM schedules WHERE schedule_id = $1', [scheduleId]), /foreign key/);
});

test('device repository reads state and only accepts a newer report', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const id = await device(db);
  const repository = createDeviceRepository({
    async query<R>(sql: string, values?: readonly unknown[]) {
      return db.query<R>(sql, values ? [...values] : undefined);
    },
  } satisfies QueryExecutor);

  assert.deepEqual(await repository.findState(id), {
    deviceId: id,
    status: 'unknown',
    firmwareVersion: null,
    lastSeenAt: null,
    scheduleRevision: '0',
    lastErrorCode: null,
    lastErrorMessage: null,
  });

  const first = await repository.updateStateIfNewer(id, {
    status: 'online',
    reportedAt: new Date('2026-10-29T01:00:00Z'),
    firmwareVersion: '0.2.0',
    errorCode: null,
    errorMessage: null,
  });
  assert.equal(first?.status, 'online');
  assert.ok(first?.lastSeenAt);
  assert.equal(first.lastSeenAt.toISOString(), '2026-10-29T01:00:00.000Z');

  const stale = await repository.updateStateIfNewer(id, {
    status: 'error',
    reportedAt: new Date('2026-10-29T00:59:59Z'),
    firmwareVersion: '0.2.0',
    errorCode: 'MOTOR_ERROR',
    errorMessage: 'Motor is blocked',
  });
  assert.equal(stale, null);
  assert.equal((await repository.findState(id))?.status, 'online');
});

test('schedule repository changes rows and device revision in one transaction', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const deviceId = await device(db);
  const connection: TransactionClient = {
    async query<R>(sql: string, values?: readonly unknown[]) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) {
        await db.exec(sql);
        return { rows: [] as R[] };
      }
      return db.query<R>(sql, values ? [...values] : undefined);
    },
    release() {},
  };
  const database: TransactionPool = {
    query: connection.query.bind(connection),
    async connect() { return connection; },
  };
  const repository = createScheduleRepository(database);
  const scheduleId = randomUUID();
  const values = {
    timeLocal: '08:30:00',
    daysOfWeek: ['mon', 'wed'] as const,
    timezone: 'Asia/Vladivostok',
    portionGrams: 45.5,
    active: true,
  };

  const created = await repository.create(deviceId, scheduleId, { ...values, daysOfWeek: [...values.daysOfWeek] });
  assert.equal(created?.revision, '1');
  assert.equal((await repository.list(deviceId))?.scheduleRevision, '1');

  const updated = await repository.update(deviceId, scheduleId, {
    ...values,
    daysOfWeek: [...values.daysOfWeek],
    timeLocal: '09:00:00',
    active: false,
  });
  assert.equal(updated?.revision, '2');
  assert.equal(updated?.timeLocal, '09:00:00');

  assert.equal(await repository.update(deviceId, randomUUID(), {
    ...values, daysOfWeek: [...values.daysOfWeek],
  }), null);
  assert.equal((await repository.list(deviceId))?.scheduleRevision, '2');

  await assert.rejects(repository.create(deviceId, randomUUID(), {
    ...values, daysOfWeek: [...values.daysOfWeek], portionGrams: 0,
  }));
  assert.equal((await repository.list(deviceId))?.scheduleRevision, '2');

  const deleted = await repository.delete(deviceId, scheduleId);
  assert.equal(deleted?.scheduleRevision, '3');
  assert.deepEqual((await repository.list(deviceId))?.items, []);
  assert.equal((await db.query('SELECT * FROM schedules WHERE schedule_id = $1', [scheduleId])).rows.length, 1);
});
