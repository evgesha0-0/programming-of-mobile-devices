import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import { buildApp } from '../src/app.js';
import { createDeviceAuthenticationRepository } from '../src/authentication/device-authentication.repository.js';
import { createDeviceAuthenticator } from '../src/authentication/device-authentication.service.js';
import { createUserAuthenticationRepository } from '../src/authentication/user-authentication.repository.js';
import { createUserAuthenticator } from '../src/authentication/user-authentication.service.js';
import { createCommandRepository, type CommandDatabase } from '../src/commands/command.repository.js';
import { MAX_MANUAL_COMMAND_TTL_MS } from '../src/commands/command.types.js';
import { runMigrations, type MigrationConnection } from '../src/db/migrations.js';
import { createDeviceRepository } from '../src/devices/device.repository.js';
import { createFeedingRepository, type FeedingDatabase } from '../src/feedings/feeding.repository.js';
import { createScheduleRepository, type TransactionClient, type TransactionPool } from '../src/schedules/schedule.repository.js';

const deviceA = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const deviceB = '4d6b9594-9278-4621-88f3-876b3d127fd8';
const scheduleB = '1875723f-f6e1-4307-92c8-81577f1ea2fb';
const feedingB = '723fb100-1524-44e4-8b0a-b91fc6eb0964';
const ownerUserId = 'fcba4f1c-7cf2-43de-b60f-97be27b5b7dc';
const viewerUserId = 'a136eb7a-c8a3-4d31-a25c-f61337241f6c';
const deviceToken = `dvc_${'a'.repeat(43)}`;
const ownerToken = `usr_${'b'.repeat(43)}`;
const viewerToken = `usr_${'c'.repeat(43)}`;

test('device credentials cannot substitute another device_id or mutate its queue', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const commandId = randomUUID();
  const feedingId = randomUUID();
  assert.equal((await fixture.commandRepository.create({
    commandId,
    feedingId,
    deviceId: deviceB,
    portionGrams: 30,
    createdAt: new Date('2000-05-01T00:00:00Z'),
    expiresAt: new Date('2000-05-01T00:05:00Z'),
  })).kind, 'created');

  const response = await fixture.app.inject({
    method: 'GET',
    url: `/api/v1/devices/${deviceB}/commands/pending`,
    headers: { authorization: `Bearer ${deviceToken}` },
  });

  assert.equal(response.statusCode, 403);
  const state = await fixture.database.query<{
    command_status: string;
    feeding_status: string;
  }>(
    `SELECT c.status AS command_status, f.status AS feeding_status
     FROM feeding_commands AS c
     JOIN feedings AS f ON f.feeding_id = c.feeding_id
     WHERE c.command_id = $1`,
    [commandId],
  );
  assert.deepEqual(state.rows[0], { command_status: 'pending', feeding_status: 'pending' });
  assert.equal((await fixture.database.query<{ last_used_at: Date | null }>(
    'SELECT last_used_at FROM device_credentials WHERE device_id = $1',
    [deviceA],
  )).rows[0]?.last_used_at, null);
});

test('feeding details cannot read a foreign feeding_id or mutate local feedings', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const commandId = randomUUID();
  const feedingId = randomUUID();
  assert.equal((await fixture.commandRepository.create({
    commandId,
    feedingId,
    deviceId: deviceA,
    portionGrams: 35,
    createdAt: new Date('2000-05-02T00:00:00Z'),
    expiresAt: new Date('2000-05-02T00:05:00Z'),
  })).kind, 'created');
  const before = await domainFeedingState(fixture.database);

  const response = await fixture.app.inject({
    method: 'GET',
    url: `/api/v1/devices/${deviceA}/feedings/${feedingB}`,
    headers: { authorization: `Bearer ${viewerToken}` },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(await domainFeedingState(fixture.database), before);
});

test('an owner cannot update a schedule belonging to another device', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const beforeSchedule = await scheduleState(fixture.database);
  const beforeDevices = await deviceRevisionState(fixture.database);

  const response = await fixture.app.inject({
    method: 'PUT',
    url: `/api/v1/devices/${deviceA}/schedules/${scheduleB}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: {
      time_local: '09:30:00',
      days_of_week: ['tue', 'thu'],
      timezone: 'Europe/Moscow',
      portion_grams: 55,
      active: false,
    },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(await scheduleState(fixture.database), beforeSchedule);
  assert.deepEqual(await deviceRevisionState(fixture.database), beforeDevices);
});

test('a viewer cannot create a manual command or feeding', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const before = await domainFeedingState(fixture.database);

  const response = await fixture.app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceA}/feeding-commands`,
    headers: { authorization: `Bearer ${viewerToken}` },
    payload: {
      command_id: randomUUID(),
      portion_grams: 40,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(await domainFeedingState(fixture.database), before);
});

test('an overlong manual command lifetime is rejected without command or feeding writes', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const before = await domainFeedingState(fixture.database);

  const response = await fixture.app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceA}/feeding-commands`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: {
      command_id: randomUUID(),
      portion_grams: 40,
      expires_at: new Date(Date.now() + MAX_MANUAL_COMMAND_TTL_MS + 60_000).toISOString(),
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  assert.deepEqual(await domainFeedingState(fixture.database), before);
});

async function createFixture() {
  const database = new PGlite();
  await runMigrations(migrationConnection(database));
  await database.query(
    'INSERT INTO devices(device_id, name) VALUES ($1, $2), ($3, $4)',
    [deviceA, 'Feeder A', deviceB, 'Feeder B'],
  );
  const transactionPool = transactionalDatabase(database);
  const commandRepository = createCommandRepository(transactionPool);
  const feedingRepository = createFeedingRepository(transactionPool);
  const scheduleRepository = createScheduleRepository(transactionPool);
  assert.ok(await scheduleRepository.create(deviceB, scheduleB, {
    timeLocal: '08:00:00',
    daysOfWeek: ['mon', 'wed'],
    timezone: 'Europe/Moscow',
    portionGrams: 45,
    active: true,
  }));
  assert.equal((await feedingRepository.createScheduledEvent({
    feedingId: feedingB,
    deviceId: deviceB,
    scheduleId: scheduleB,
    source: 'scheduled',
    portionGrams: 45,
    actualGrams: 44.5,
    status: 'completed',
    createdAt: new Date('2026-11-01T08:00:00Z'),
    startedAt: new Date('2026-11-01T08:00:01Z'),
    finishedAt: new Date('2026-11-01T08:00:05Z'),
    errorCode: null,
    errorMessage: null,
  })).kind, 'created');
  await insertDeviceCredential(database, deviceA, deviceToken);
  await insertUserAccess(database, ownerUserId, ownerToken, 'owner');
  await insertUserAccess(database, viewerUserId, viewerToken, 'viewer');

  const app = await buildApp({
    checkDatabase: async () => undefined,
    commandRepository,
    deviceRepository: createDeviceRepository(transactionPool),
    feedingRepository,
    scheduleRepository,
    deviceAuthenticator: createDeviceAuthenticator(
      createDeviceAuthenticationRepository(transactionPool),
    ),
    userAuthenticator: createUserAuthenticator(
      createUserAuthenticationRepository(transactionPool),
    ),
  });
  return {
    app,
    commandRepository,
    database,
    async close() {
      await app.close();
      await database.close();
    },
  };
}

async function insertDeviceCredential(
  database: PGlite,
  deviceId: string,
  token: string,
): Promise<void> {
  const tokenHash = createHash('sha256').update(token, 'utf8').digest();
  await database.query(
    `INSERT INTO device_credentials(credential_id, device_id, token_hash, token_hint)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), deviceId, tokenHash, tokenHash.subarray(0, 6).toString('hex')],
  );
}

async function insertUserAccess(
  database: PGlite,
  userId: string,
  token: string,
  role: 'owner' | 'viewer',
): Promise<void> {
  const tokenHash = createHash('sha256').update(token, 'utf8').digest();
  await database.query('INSERT INTO users(user_id) VALUES ($1)', [userId]);
  await database.query(
    `INSERT INTO user_credentials(credential_id, user_id, token_hash, token_hint)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), userId, tokenHash, tokenHash.subarray(0, 6).toString('hex')],
  );
  await database.query(
    `INSERT INTO user_devices(user_device_id, user_id, device_id, role)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), userId, deviceA, role],
  );
}

async function domainFeedingState(database: PGlite): Promise<{
  commands: Record<string, unknown>[];
  feedings: Record<string, unknown>[];
}> {
  const commands = await database.query<Record<string, unknown>>(
    `SELECT command_id, feeding_id, device_id, portion_grams, status,
            created_at, expires_at, started_at, finished_at, error_code
     FROM feeding_commands ORDER BY command_id`,
  );
  const feedings = await database.query<Record<string, unknown>>(
    `SELECT feeding_id, device_id, schedule_id, command_id, source, portion_grams,
            actual_grams, status, created_at, started_at, finished_at, error_code, error_message
     FROM feedings ORDER BY feeding_id`,
  );
  return { commands: commands.rows, feedings: feedings.rows };
}

async function scheduleState(database: PGlite): Promise<Record<string, unknown>[]> {
  return (await database.query<Record<string, unknown>>(
    `SELECT schedule_id, device_id, time_local, days_of_week, timezone,
            portion_grams, active, revision, created_at, updated_at, deleted_at
     FROM schedules ORDER BY schedule_id`,
  )).rows;
}

async function deviceRevisionState(database: PGlite): Promise<Record<string, unknown>[]> {
  return (await database.query<Record<string, unknown>>(
    'SELECT device_id, schedule_revision FROM devices ORDER BY device_id',
  )).rows;
}

function migrationConnection(database: PGlite): MigrationConnection {
  return {
    async query(sql, values) {
      if (values || sql.trimStart().startsWith('SELECT')) {
        const result = await database.query<Record<string, unknown>>(sql, values);
        return { rows: result.rows };
      }
      await database.exec(sql);
      return { rows: [] };
    },
  };
}

function transactionalDatabase(
  database: PGlite,
): TransactionPool & CommandDatabase & FeedingDatabase {
  const connection: TransactionClient = {
    async query<R>(sql: string, values?: readonly unknown[]) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) {
        await database.exec(sql);
        return { rows: [] as R[] };
      }
      return database.query<R>(sql, values ? [...values] : undefined);
    },
    release() {},
  };
  return {
    query: connection.query.bind(connection),
    async connect() { return connection; },
  };
}
