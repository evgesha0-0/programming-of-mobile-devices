import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { createCommandRepository, type CommandDatabase } from '../src/commands/command.repository.js';
import { createDeviceAuthenticationRepository } from '../src/authentication/device-authentication.repository.js';
import { createUserAuthenticationRepository } from '../src/authentication/user-authentication.repository.js';
import { loadMigrations, runMigrations, type Migration, type MigrationConnection } from '../src/db/migrations.js';
import { createDeviceRepository, type QueryExecutor } from '../src/devices/device.repository.js';
import { createFeedingRepository, type FeedingDatabase } from '../src/feedings/feeding.repository.js';
import { createDeviceProvisioningRepository } from '../src/provisioning/device-provisioning.repository.js';
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

function transactionalDatabase(db: PGlite): TransactionPool & CommandDatabase & FeedingDatabase {
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

  return {
    query: connection.query.bind(connection),
    async connect() { return connection; },
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

test('migrations create tables, and the second run preserves existing data', async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  assert.deepEqual(await runMigrations(client(db)), [
    '001_initial_schema.sql',
    '002_device_credentials.sql',
    '003_user_device_access.sql',
    '004_user_credentials.sql',
  ]);
  const id = await device(db);
  assert.deepEqual(await runMigrations(client(db)), []);
  assert.equal((await db.query('SELECT * FROM devices WHERE device_id = $1', [id])).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length, 4);
});

test('changed or missing applied migration is rejected without changing the database', async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  const migrations = await loadMigrations();
  await runMigrations(client(db), migrations);
  await assert.rejects(runMigrations(client(db), [migration('001_initial_schema.sql', 'SELECT 1')]), /history differs/);
  await assert.rejects(runMigrations(client(db), []), /history differs/);
  assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length, 4);
});

test('failure rolls back all pending migrations and journal entries in the batch', async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  const base = await loadMigrations();
  await runMigrations(client(db), base);
  const next = migration('005_example.sql', 'CREATE TABLE migration_probe (id integer)');
  const broken = migration('006_broken.sql', 'INSERT INTO missing_table VALUES (1)');
  await assert.rejects(runMigrations(client(db), [...base, next, broken]), /missing_table/);
  assert.equal((await db.query<{ name: string | null }>("SELECT to_regclass('migration_probe') AS name")).rows[0]?.name, null);
  assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length, 4);
  assert.deepEqual(await runMigrations(client(db), [...base, next]), ['005_example.sql']);
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

test('device credentials store only hashes and enforce a one-way lifecycle', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const deviceId = await device(db);
  const credentialId = randomUUID();
  const firstHash = '11'.repeat(32);
  const secondHash = '22'.repeat(32);
  const createdAt = '2026-10-25T12:00:00Z';

  await db.query(`INSERT INTO device_credentials(
      credential_id, device_id, token_hash, token_hint, created_at
    ) VALUES ($1, $2, decode($3, 'hex'), $4, $5)`,
  [credentialId, deviceId, firstHash, firstHash.slice(0, 12), createdAt]);

  const columns = await db.query<{ column_name: string }>(`SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'device_credentials'
    ORDER BY ordinal_position`);
  assert.deepEqual(columns.rows.map(({ column_name }) => column_name), [
    'credential_id', 'device_id', 'token_hash', 'token_hint', 'created_at', 'last_used_at', 'revoked_at',
  ]);
  const stored = await db.query<{ token_hash: string; hash_length: number; token_hint: string }>(`SELECT
      encode(token_hash, 'hex') AS token_hash,
      octet_length(token_hash) AS hash_length,
      token_hint
    FROM device_credentials
    WHERE credential_id = $1`, [credentialId]);
  assert.deepEqual(stored.rows[0], {
    token_hash: firstHash,
    hash_length: 32,
    token_hint: firstHash.slice(0, 12),
  });

  await assert.rejects(db.query(`INSERT INTO device_credentials(
      credential_id, device_id, token_hash, token_hint
    ) VALUES ($1, $2, decode($3, 'hex'), $4)`,
  [randomUUID(), deviceId, secondHash, secondHash.slice(0, 12)]), /unique/);
  await assert.rejects(db.query(`INSERT INTO device_credentials(
      credential_id, device_id, token_hash, token_hint
    ) VALUES ($1, $2, decode('aa', 'hex'), 'aa')`,
  [randomUUID(), await device(db)]), /token_hash_length/);
  await assert.rejects(db.query(`UPDATE device_credentials
    SET token_hash = decode($2, 'hex'), token_hint = $3
    WHERE credential_id = $1`, [credentialId, secondHash, secondHash.slice(0, 12)]), /cannot be changed/);

  await db.query(`UPDATE device_credentials SET last_used_at = '2026-10-25T12:01:00Z'
    WHERE credential_id = $1`, [credentialId]);
  await assert.rejects(db.query(`UPDATE device_credentials SET last_used_at = '2026-10-25T12:00:30Z'
    WHERE credential_id = $1`, [credentialId]), /cannot move backwards/);
  await db.query(`UPDATE device_credentials SET revoked_at = '2026-10-25T12:02:00Z'
    WHERE credential_id = $1`, [credentialId]);
  await assert.rejects(db.query('UPDATE device_credentials SET revoked_at = NULL WHERE credential_id = $1',
    [credentialId]), /cannot be restored/);
  await assert.rejects(db.query(`UPDATE device_credentials SET last_used_at = '2026-10-25T12:01:30Z'
    WHERE credential_id = $1`, [credentialId]), /cannot be used/);

  const activeCredentialId = randomUUID();
  await db.query(`INSERT INTO device_credentials(
      credential_id, device_id, token_hash, token_hint, created_at
    ) VALUES ($1, $2, decode($3, 'hex'), $4, $5)`,
  [activeCredentialId, deviceId, secondHash, secondHash.slice(0, 12), '2026-10-25T12:03:00Z']);
  const credentials = await db.query<{ credential_id: string; revoked_at: Date | null }>(`SELECT
      credential_id, revoked_at
    FROM device_credentials
    WHERE device_id = $1
    ORDER BY created_at`, [deviceId]);
  assert.equal(credentials.rows.length, 2);
  assert.equal(credentials.rows[0]?.credential_id, credentialId);
  assert.ok(credentials.rows[0]?.revoked_at);
  assert.deepEqual(credentials.rows[1], { credential_id: activeCredentialId, revoked_at: null });

  const anotherDeviceId = await device(db);
  await assert.rejects(db.query(`INSERT INTO device_credentials(
      credential_id, device_id, token_hash, token_hint
    ) VALUES ($1, $2, decode($3, 'hex'), $4)`,
  [randomUUID(), anotherDeviceId, secondHash, secondHash.slice(0, 12)]), /unique/);
});

test('device provisioning creates, rotates, and revokes credentials transactionally', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const provisioning = createDeviceProvisioningRepository(transactionalDatabase(db));
  const deviceId = randomUUID();
  const firstCredentialId = randomUUID();
  const firstHash = Buffer.from('33'.repeat(32), 'hex');

  await provisioning.createDevice({
    deviceId,
    name: 'Кормушка',
    credential: {
      credentialId: firstCredentialId,
      tokenHash: firstHash,
      tokenHint: firstHash.subarray(0, 6).toString('hex'),
    },
  });
  assert.equal((await db.query('SELECT * FROM devices WHERE device_id = $1', [deviceId])).rows.length, 1);
  assert.equal((await db.query(
    'SELECT * FROM device_credentials WHERE device_id = $1 AND revoked_at IS NULL',
    [deviceId],
  )).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM user_devices WHERE device_id = $1', [deviceId])).rows.length, 0);

  const secondCredentialId = randomUUID();
  const secondHash = Buffer.from('44'.repeat(32), 'hex');
  assert.equal(await provisioning.rotateCredential(deviceId, {
    credentialId: secondCredentialId,
    tokenHash: secondHash,
    tokenHint: secondHash.subarray(0, 6).toString('hex'),
  }), true);
  const history = await db.query<{ credential_id: string; revoked_at: Date | null }>(`SELECT
      credential_id, revoked_at
    FROM device_credentials
    WHERE device_id = $1
    ORDER BY created_at, credential_id`, [deviceId]);
  assert.equal(history.rows.length, 2);
  assert.ok(history.rows.find(({ credential_id }) => credential_id === firstCredentialId)?.revoked_at);
  assert.equal(history.rows.find(({ credential_id }) => credential_id === secondCredentialId)?.revoked_at, null);

  assert.equal(await provisioning.revokeCredential(deviceId), 'revoked');
  assert.equal(await provisioning.revokeCredential(deviceId), 'already_revoked');
  assert.equal(await provisioning.rotateCredential(randomUUID(), {
    credentialId: randomUUID(),
    tokenHash: Buffer.from('55'.repeat(32), 'hex'),
    tokenHint: '555555555555',
  }), false);

  const rolledBackDeviceId = randomUUID();
  const rollbackHash = Buffer.from('66'.repeat(32), 'hex');
  await assert.rejects(provisioning.createDevice({
    deviceId: rolledBackDeviceId,
    name: 'Не должна сохраниться',
    credential: {
      credentialId: firstCredentialId,
      tokenHash: rollbackHash,
      tokenHint: rollbackHash.subarray(0, 6).toString('hex'),
    },
  }), /unique/);
  assert.equal((await db.query('SELECT * FROM devices WHERE device_id = $1', [rolledBackDeviceId])).rows.length, 0);
});

test('device authentication resolves only active hashes and records successful use', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const provisioning = createDeviceProvisioningRepository(transactionalDatabase(db));
  const authentication = createDeviceAuthenticationRepository(transactionalDatabase(db));
  const deviceId = randomUUID();
  const credentialId = randomUUID();
  const tokenHash = Buffer.from('77'.repeat(32), 'hex');

  await provisioning.createDevice({
    deviceId,
    name: 'Кормушка',
    credential: {
      credentialId,
      tokenHash,
      tokenHint: tokenHash.subarray(0, 6).toString('hex'),
    },
  });
  assert.deepEqual(await authentication.findActiveByTokenHash(tokenHash), {
    credentialId,
    deviceId,
  });
  assert.equal(await authentication.markUsedIfActive(credentialId), true);
  const used = await db.query<{ last_used_at: Date | null }>(
    'SELECT last_used_at FROM device_credentials WHERE credential_id = $1',
    [credentialId],
  );
  assert.ok(used.rows[0]?.last_used_at);

  assert.equal(await provisioning.revokeCredential(deviceId), 'revoked');
  assert.equal(await authentication.findActiveByTokenHash(tokenHash), null);
  assert.equal(await authentication.markUsedIfActive(credentialId), false);
});

test('user identities and device access require explicit unique memberships', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const deviceId = await device(db);
  const ownerId = randomUUID();
  const viewerId = randomUUID();
  const anotherUserId = randomUUID();
  await db.query('INSERT INTO users (user_id) VALUES ($1), ($2), ($3)', [
    ownerId,
    viewerId,
    anotherUserId,
  ]);
  const issuer = 'https://identity.example/realms/smart-cat-feeder';
  await db.query(`INSERT INTO user_identities (identity_id, user_id, issuer, subject)
    VALUES ($1, $2, $3, $4), ($5, $6, $3, $7)`, [
    randomUUID(), ownerId, issuer, 'keycloak-owner',
    randomUUID(), viewerId, 'keycloak-viewer',
  ]);

  assert.equal((await db.query('SELECT * FROM user_devices WHERE device_id = $1', [deviceId])).rows.length, 0);
  const ownerAccessId = randomUUID();
  await db.query(`INSERT INTO user_devices (user_device_id, user_id, device_id, role)
    VALUES ($1, $2, $3, 'owner')`, [ownerAccessId, ownerId, deviceId]);
  await assert.rejects(db.query(`INSERT INTO user_devices (user_device_id, user_id, device_id, role)
    VALUES ($1, $2, $3, 'owner')`, [randomUUID(), viewerId, deviceId]), /unique/);

  const viewerAccessId = randomUUID();
  await db.query(`INSERT INTO user_devices (user_device_id, user_id, device_id, role)
    VALUES ($1, $2, $3, 'viewer')`, [viewerAccessId, viewerId, deviceId]);
  await assert.rejects(db.query(`INSERT INTO user_devices (user_device_id, user_id, device_id, role)
    VALUES ($1, $2, $3, 'viewer')`, [randomUUID(), viewerId, deviceId]), /unique/);
  await assert.rejects(db.query(
    "UPDATE user_devices SET role = 'viewer' WHERE user_device_id = $1",
    [ownerAccessId],
  ), /cannot be changed/);
  await assert.rejects(db.query(`INSERT INTO user_devices (user_device_id, user_id, device_id, role)
    VALUES ($1, $2, $3, 'administrator')`, [randomUUID(), anotherUserId, deviceId]));

  await db.query('UPDATE user_devices SET revoked_at = clock_timestamp() WHERE user_device_id = $1',
    [viewerAccessId]);
  await assert.rejects(db.query(
    'UPDATE user_devices SET revoked_at = NULL WHERE user_device_id = $1',
    [viewerAccessId],
  ), /cannot be restored/);
  await db.query(`INSERT INTO user_devices (user_device_id, user_id, device_id, role)
    VALUES ($1, $2, $3, 'viewer')`, [randomUUID(), viewerId, deviceId]);
  assert.equal((await db.query(
    'SELECT * FROM user_devices WHERE user_id = $1 AND device_id = $2',
    [viewerId, deviceId],
  )).rows.length, 2);

  await assert.rejects(db.query(`INSERT INTO user_identities (identity_id, user_id, issuer, subject)
    VALUES ($1, $2, $3, $4)`, [randomUUID(), anotherUserId, issuer, 'keycloak-owner']), /unique/);
  await assert.rejects(db.query(`INSERT INTO user_identities (identity_id, user_id, issuer, subject)
    VALUES ($1, $2, $3, $4)`, [randomUUID(), ownerId, issuer, 'second-owner-account']), /unique/);
  await assert.rejects(db.query(
    'UPDATE user_identities SET subject = $2 WHERE user_id = $1',
    [ownerId, 'changed-subject'],
  ), /cannot be changed/);
});

test('user and external identity lifecycle timestamps cannot move backwards', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const userId = randomUUID();
  const identityId = randomUUID();
  await db.query(`INSERT INTO users (user_id, created_at)
    VALUES ($1, '2026-11-23T00:00:00Z')`, [userId]);
  await db.query(`INSERT INTO user_identities (
      identity_id, user_id, issuer, subject, created_at, last_seen_at
    ) VALUES ($1, $2, $3, $4, '2026-11-23T00:00:00Z', '2026-11-23T00:01:00Z')`, [
    identityId,
    userId,
    'https://identity.example/realms/smart-cat-feeder',
    'keycloak-user',
  ]);

  await assert.rejects(db.query(`UPDATE user_identities
    SET last_seen_at = '2026-11-23T00:00:30Z'
    WHERE identity_id = $1`, [identityId]), /cannot move backwards/);
  await db.query(`UPDATE users SET disabled_at = '2026-11-23T00:02:00Z' WHERE user_id = $1`, [userId]);
  await assert.rejects(db.query('UPDATE users SET disabled_at = NULL WHERE user_id = $1', [userId]),
    /cannot be restored/);
});

test('user authentication resolves only active access for the requested device', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const repository = createUserAuthenticationRepository(transactionalDatabase(db));
  const userId = randomUUID();
  const credentialId = randomUUID();
  const deviceId = await device(db);
  const otherDeviceId = await device(db);
  const tokenHash = createHash('sha256').update(`usr_${'a'.repeat(43)}`).digest();
  await db.query('INSERT INTO users (user_id) VALUES ($1)', [userId]);
  await db.query(`INSERT INTO user_credentials (
      credential_id, user_id, token_hash, token_hint
    ) VALUES ($1, $2, $3, $4)`, [
    credentialId,
    userId,
    tokenHash,
    tokenHash.subarray(0, 6).toString('hex'),
  ]);
  const accessId = randomUUID();
  await db.query(`INSERT INTO user_devices (user_device_id, user_id, device_id, role)
    VALUES ($1, $2, $3, 'owner')`, [accessId, userId, deviceId]);

  assert.deepEqual(await repository.authenticateToken(tokenHash), { credentialId, userId });
  assert.deepEqual(await repository.findActiveAccess(userId, deviceId), {
    userId,
    deviceId,
    role: 'owner',
  });
  assert.equal(await repository.findActiveAccess(userId, otherDeviceId), null);
  const used = await db.query<{ last_used_at: Date | null }>(
    'SELECT last_used_at FROM user_credentials WHERE credential_id = $1',
    [credentialId],
  );
  assert.ok(used.rows[0]?.last_used_at);

  await db.query('UPDATE user_devices SET revoked_at = clock_timestamp() WHERE user_device_id = $1',
    [accessId]);
  assert.equal(await repository.findActiveAccess(userId, deviceId), null);
  await db.query(`INSERT INTO user_devices (user_device_id, user_id, device_id, role)
    VALUES ($1, $2, $3, 'viewer')`, [randomUUID(), userId, deviceId]);
  assert.equal((await repository.findActiveAccess(userId, deviceId))?.role, 'viewer');

  await db.query('UPDATE users SET disabled_at = clock_timestamp() WHERE user_id = $1', [userId]);
  assert.equal(await repository.authenticateToken(tokenHash), null);
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
  const database = transactionalDatabase(db);
  const repository = createScheduleRepository(database);
  const scheduleId = randomUUID();
  const values = {
    timeLocal: '08:30:00',
    daysOfWeek: ['mon', 'wed'] as const,
    timezone: 'Asia/Vladivostok',
    portionGrams: 45.5,
    active: true,
  };

  const emptySnapshot = await repository.sync(deviceId);
  assert.equal(emptySnapshot?.scheduleRevision, '0');
  assert.deepEqual(emptySnapshot?.items, []);

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

  const snapshot = await repository.sync(deviceId);
  assert.equal(snapshot?.scheduleRevision, '3');
  assert.equal(snapshot?.items.length, 1);
  assert.equal(snapshot?.items[0]?.scheduleId, scheduleId);
  assert.ok(snapshot?.items[0]?.deletedAt);
  assert.ok(snapshot?.generatedAt instanceof Date);
  assert.equal(await repository.sync(randomUUID()), null);
});

test('manual command repository creates command and feeding atomically with idempotency', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const deviceId = await device(db);
  const otherDeviceId = await device(db);
  const repository = createCommandRepository(transactionalDatabase(db));
  const commandId = randomUUID();
  const feedingId = randomUUID();
  const values = {
    commandId,
    feedingId,
    deviceId,
    portionGrams: 40,
    createdAt: new Date('2026-10-29T03:00:00Z'),
    expiresAt: new Date('2026-10-29T03:05:00Z'),
  };

  const created = await repository.create(values);
  assert.equal(created.kind, 'created');
  assert.equal(created.kind === 'created' && created.command.feedingId, feedingId);
  assert.equal((await db.query('SELECT * FROM feeding_commands')).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM feedings')).rows.length, 1);

  const repeated = await repository.create({
    ...values,
    feedingId: randomUUID(),
    createdAt: new Date('2026-10-29T04:00:00Z'),
  });
  assert.equal(repeated.kind, 'repeated');
  assert.equal(repeated.kind === 'repeated' && repeated.command.feedingId, feedingId);
  assert.equal((await db.query('SELECT * FROM feeding_commands')).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM feedings')).rows.length, 1);

  assert.equal((await repository.create({ ...values, portionGrams: 50 })).kind, 'conflict');
  assert.equal((await repository.create({ ...values, deviceId: otherDeviceId })).kind, 'conflict');
  assert.equal((await repository.create({
    ...values,
    commandId: randomUUID(),
    feedingId: randomUUID(),
    createdAt: values.expiresAt,
  })).kind, 'invalid_expiry');
  assert.equal((await repository.create({
    ...values,
    commandId: randomUUID(),
    feedingId: randomUUID(),
    deviceId: randomUUID(),
  })).kind, 'device_not_found');

  const queueDeviceId = await device(db);
  const expiredCommandId = randomUUID();
  const expiredFeedingId = randomUUID();
  const firstPendingCommandId = randomUUID();
  const secondPendingCommandId = randomUUID();
  const otherDeviceCommandId = randomUUID();

  await repository.create({
    commandId: expiredCommandId,
    feedingId: expiredFeedingId,
    deviceId: queueDeviceId,
    portionGrams: 30,
    createdAt: new Date('2000-01-01T00:00:00Z'),
    expiresAt: new Date('2000-01-01T00:05:00Z'),
  });
  await repository.create({
    commandId: firstPendingCommandId,
    feedingId: randomUUID(),
    deviceId: queueDeviceId,
    portionGrams: 35,
    createdAt: new Date('2090-01-01T00:00:00Z'),
    expiresAt: new Date('2099-01-01T00:05:00Z'),
  });
  await repository.create({
    commandId: secondPendingCommandId,
    feedingId: randomUUID(),
    deviceId: queueDeviceId,
    portionGrams: 45,
    createdAt: new Date('2090-01-01T00:00:01Z'),
    expiresAt: new Date('2099-01-01T00:05:00Z'),
  });
  await repository.create({
    commandId: otherDeviceCommandId,
    feedingId: randomUUID(),
    deviceId: otherDeviceId,
    portionGrams: 20,
    createdAt: new Date('2000-01-01T00:00:00Z'),
    expiresAt: new Date('2000-01-01T00:05:00Z'),
  });

  const limited = await repository.listPending(queueDeviceId, 1);
  assert.equal(limited.kind, 'found');
  assert.ok(limited.kind === 'found' && limited.commands.serverTime instanceof Date);
  assert.deepEqual(
    limited.kind === 'found' && limited.commands.items.map((item) => item.commandId),
    [firstPendingCommandId],
  );

  const expired = await db.query<{
    command_status: string;
    feeding_status: string;
    command_finished: Date | null;
    feeding_finished: Date | null;
  }>(
    `SELECT
       c.status AS command_status,
       f.status AS feeding_status,
       c.finished_at AS command_finished,
       f.finished_at AS feeding_finished
     FROM feeding_commands c
     JOIN feedings f ON f.feeding_id = c.feeding_id
     WHERE c.command_id = $1`,
    [expiredCommandId],
  );
  assert.equal(expired.rows[0]?.command_status, 'expired');
  assert.equal(expired.rows[0]?.feeding_status, 'expired');
  assert.ok(expired.rows[0]?.command_finished);
  assert.deepEqual(expired.rows[0]?.feeding_finished, expired.rows[0]?.command_finished);

  const allPending = await repository.listPending(queueDeviceId, 10);
  assert.deepEqual(
    allPending.kind === 'found' && allPending.commands.items.map((item) => item.commandId),
    [firstPendingCommandId, secondPendingCommandId],
  );
  assert.equal(
    (await db.query<{ status: string }>(
      'SELECT status FROM feeding_commands WHERE command_id = $1',
      [otherDeviceCommandId],
    )).rows[0]?.status,
    'pending',
  );
  assert.equal((await repository.listPending(randomUUID(), 10)).kind, 'device_not_found');

  const ackDeviceId = await device(db);
  const ackCommandId = randomUUID();
  const ackFeedingId = randomUUID();
  await repository.create({
    commandId: ackCommandId,
    feedingId: ackFeedingId,
    deviceId: ackDeviceId,
    portionGrams: 40,
    createdAt: new Date('2090-01-01T00:00:00Z'),
    expiresAt: new Date('2099-01-01T00:05:00Z'),
  });
  const acknowledgment = {
    commandId: ackCommandId,
    feedingId: ackFeedingId,
    deviceId: ackDeviceId,
    startedAt: new Date('2090-01-01T00:00:10Z'),
  };

  const acknowledged = await repository.acknowledge(acknowledgment);
  assert.equal(acknowledged.kind, 'acknowledged');
  assert.deepEqual(await repository.acknowledge(acknowledgment), acknowledged);
  assert.equal((await repository.acknowledge({
    ...acknowledgment,
    feedingId: randomUUID(),
  })).kind, 'conflict');
  assert.equal((await repository.acknowledge({
    ...acknowledgment,
    startedAt: new Date('2090-01-01T00:00:11Z'),
  })).kind, 'conflict');

  const runningRows = await db.query<{
    command_status: string;
    feeding_status: string;
    command_started: Date | null;
    feeding_started: Date | null;
  }>(
    `SELECT
       c.status AS command_status,
       f.status AS feeding_status,
       c.started_at AS command_started,
       f.started_at AS feeding_started
     FROM feeding_commands c
     JOIN feedings f ON f.feeding_id = c.feeding_id
     WHERE c.command_id = $1`,
    [ackCommandId],
  );
  assert.equal(runningRows.rows[0]?.command_status, 'running');
  assert.equal(runningRows.rows[0]?.feeding_status, 'running');
  assert.deepEqual(runningRows.rows[0]?.command_started, acknowledgment.startedAt);
  assert.deepEqual(runningRows.rows[0]?.feeding_started, acknowledgment.startedAt);

  const invalidStartedCommandId = randomUUID();
  const invalidStartedFeedingId = randomUUID();
  await repository.create({
    commandId: invalidStartedCommandId,
    feedingId: invalidStartedFeedingId,
    deviceId: ackDeviceId,
    portionGrams: 25,
    createdAt: new Date('2090-02-01T00:00:00Z'),
    expiresAt: new Date('2099-02-01T00:05:00Z'),
  });
  assert.equal((await repository.acknowledge({
    commandId: invalidStartedCommandId,
    feedingId: invalidStartedFeedingId,
    deviceId: ackDeviceId,
    startedAt: new Date('2090-01-31T23:59:59Z'),
  })).kind, 'invalid_started_at');

  const expiredAckCommandId = randomUUID();
  const expiredAckFeedingId = randomUUID();
  await repository.create({
    commandId: expiredAckCommandId,
    feedingId: expiredAckFeedingId,
    deviceId: ackDeviceId,
    portionGrams: 20,
    createdAt: new Date('2000-02-01T00:00:00Z'),
    expiresAt: new Date('2000-02-01T00:05:00Z'),
  });
  assert.equal((await repository.acknowledge({
    commandId: expiredAckCommandId,
    feedingId: expiredAckFeedingId,
    deviceId: ackDeviceId,
    startedAt: new Date('2000-02-01T00:04:00Z'),
  })).kind, 'conflict');
  const expiredAckRows = await db.query<{ command_status: string; feeding_status: string }>(
    `SELECT c.status AS command_status, f.status AS feeding_status
     FROM feeding_commands c
     JOIN feedings f ON f.feeding_id = c.feeding_id
     WHERE c.command_id = $1`,
    [expiredAckCommandId],
  );
  assert.equal(expiredAckRows.rows[0]?.command_status, 'expired');
  assert.equal(expiredAckRows.rows[0]?.feeding_status, 'expired');
  assert.equal((await repository.acknowledge({
    ...acknowledgment,
    commandId: randomUUID(),
  })).kind, 'not_found');

  const completedResult = {
    deviceId: ackDeviceId,
    feedingId: ackFeedingId,
    commandId: ackCommandId,
    source: 'manual' as const,
    portionGrams: 40,
    actualGrams: 39.5,
    status: 'completed' as const,
    startedAt: acknowledgment.startedAt,
    finishedAt: new Date('2090-01-01T00:00:20Z'),
    errorCode: null,
    errorMessage: null,
  };
  const completed = await repository.submitResult(completedResult);
  assert.equal(completed.kind, 'accepted');
  assert.deepEqual(await repository.submitResult(completedResult), completed);
  assert.equal((await repository.submitResult({
    ...completedResult,
    actualGrams: 38,
  })).kind, 'conflict');
  assert.equal((await repository.submitResult({
    ...completedResult,
    finishedAt: new Date('2089-12-31T23:59:59Z'),
  })).kind, 'invalid_timeline');

  const completedRows = await db.query<{
    command_status: string;
    feeding_status: string;
    actual_grams: string | number | null;
    command_finished: Date | null;
    feeding_finished: Date | null;
  }>(
    `SELECT
       c.status AS command_status,
       f.status AS feeding_status,
       f.actual_grams,
       c.finished_at AS command_finished,
       f.finished_at AS feeding_finished
     FROM feeding_commands c
     JOIN feedings f ON f.feeding_id = c.feeding_id
     WHERE c.command_id = $1`,
    [ackCommandId],
  );
  assert.equal(completedRows.rows[0]?.command_status, 'completed');
  assert.equal(completedRows.rows[0]?.feeding_status, 'completed');
  assert.equal(Number(completedRows.rows[0]?.actual_grams), 39.5);
  assert.deepEqual(completedRows.rows[0]?.command_finished, completedResult.finishedAt);
  assert.deepEqual(completedRows.rows[0]?.feeding_finished, completedResult.finishedAt);

  const failedCommandId = randomUUID();
  const failedFeedingId = randomUUID();
  const failedStartedAt = new Date('2090-03-01T00:00:10Z');
  await repository.create({
    commandId: failedCommandId,
    feedingId: failedFeedingId,
    deviceId: ackDeviceId,
    portionGrams: 25,
    createdAt: new Date('2090-03-01T00:00:00Z'),
    expiresAt: new Date('2099-03-01T00:05:00Z'),
  });
  await repository.acknowledge({
    commandId: failedCommandId,
    feedingId: failedFeedingId,
    deviceId: ackDeviceId,
    startedAt: failedStartedAt,
  });
  const failed = await repository.submitResult({
    deviceId: ackDeviceId,
    feedingId: failedFeedingId,
    commandId: failedCommandId,
    source: 'manual',
    portionGrams: 25,
    actualGrams: null,
    status: 'failed',
    startedAt: failedStartedAt,
    finishedAt: new Date('2090-03-01T00:00:15Z'),
    errorCode: 'MOTOR_ERROR',
    errorMessage: 'Motor is blocked',
  });
  assert.equal(failed.kind, 'accepted');
  const failedRows = await db.query<{
    command_status: string;
    feeding_status: string;
    command_error_code: string | null;
    feeding_error_code: string | null;
    error_message: string | null;
  }>(
    `SELECT
       c.status AS command_status,
       f.status AS feeding_status,
       c.error_code AS command_error_code,
       f.error_code AS feeding_error_code,
       f.error_message
     FROM feeding_commands c
     JOIN feedings f ON f.feeding_id = c.feeding_id
     WHERE c.command_id = $1`,
    [failedCommandId],
  );
  assert.equal(failedRows.rows[0]?.command_status, 'failed');
  assert.equal(failedRows.rows[0]?.feeding_status, 'failed');
  assert.equal(failedRows.rows[0]?.command_error_code, 'MOTOR_ERROR');
  assert.equal(failedRows.rows[0]?.feeding_error_code, 'MOTOR_ERROR');
  assert.equal(failedRows.rows[0]?.error_message, 'Motor is blocked');

  assert.equal((await repository.submitResult({
    ...completedResult,
    feedingId: randomUUID(),
  })).kind, 'not_found');
  assert.equal((await repository.submitResult({
    ...completedResult,
    feedingId: invalidStartedFeedingId,
    commandId: invalidStartedCommandId,
    portionGrams: 25,
    startedAt: new Date('2090-02-01T00:00:00Z'),
    finishedAt: new Date('2090-02-01T00:00:10Z'),
  })).kind, 'conflict');
});

test('scheduled feeding repository accepts offline events idempotently', async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await runMigrations(client(db));
  const deviceId = await device(db);
  const scheduleId = await schedule(db, deviceId);
  await db.query('UPDATE schedules SET deleted_at = now() WHERE schedule_id = $1', [scheduleId]);
  const repository = createFeedingRepository(transactionalDatabase(db));
  const values = {
    feedingId: randomUUID(),
    deviceId,
    scheduleId,
    source: 'scheduled' as const,
    portionGrams: 40,
    actualGrams: 39.5,
    status: 'completed' as const,
    createdAt: new Date('2026-11-03T05:59:00Z'),
    startedAt: new Date('2026-11-03T06:00:00Z'),
    finishedAt: new Date('2026-11-03T06:00:10Z'),
    errorCode: null,
    errorMessage: null,
  };

  const created = await repository.createScheduledEvent(values);
  assert.equal(created.kind, 'created');
  assert.equal(created.kind === 'created' && created.event.scheduleId, scheduleId);
  assert.equal((await db.query('SELECT * FROM feedings WHERE feeding_id = $1', [values.feedingId])).rows.length, 1);

  const repeated = await repository.createScheduledEvent(values);
  assert.equal(repeated.kind, 'repeated');
  assert.deepEqual(
    repeated.kind === 'repeated' && repeated.event.receivedAt,
    created.kind === 'created' && created.event.receivedAt,
  );
  assert.equal((await repository.createScheduledEvent({
    ...values,
    actualGrams: 38,
  })).kind, 'conflict');

  const failed = await repository.createScheduledEvent({
    ...values,
    feedingId: randomUUID(),
    actualGrams: null,
    status: 'failed',
    errorCode: 'MOTOR_ERROR',
    errorMessage: 'Motor is blocked',
  });
  assert.equal(failed.kind, 'created');
  assert.equal(failed.kind === 'created' && failed.event.actualGrams, null);

  assert.equal((await repository.createScheduledEvent({
    ...values,
    feedingId: randomUUID(),
    finishedAt: new Date('2026-11-03T05:59:59Z'),
  })).kind, 'invalid_timeline');
  assert.equal((await repository.createScheduledEvent({
    ...values,
    feedingId: randomUUID(),
    scheduleId: randomUUID(),
  })).kind, 'not_found');
  assert.equal((await repository.createScheduledEvent({
    ...values,
    feedingId: randomUUID(),
    deviceId: randomUUID(),
  })).kind, 'not_found');

  const firstPage = await repository.list(deviceId, 1, null);
  assert.equal(firstPage?.items.length, 1);
  assert.ok(firstPage?.nextCursor);
  const secondPage = await repository.list(deviceId, 1, firstPage?.nextCursor ?? null);
  assert.equal(secondPage?.items.length, 1);
  assert.equal(secondPage?.nextCursor, null);
  assert.deepEqual(
    new Set([
      ...(firstPage?.items.map((item) => item.feedingId) ?? []),
      ...(secondPage?.items.map((item) => item.feedingId) ?? []),
    ]),
    new Set([
      values.feedingId,
      failed.kind === 'created' ? failed.event.feedingId : '',
    ]),
  );
  assert.equal(await repository.list(randomUUID(), 50, null), null);

  const completedDetails = await repository.find(deviceId, values.feedingId);
  assert.equal(completedDetails?.source, 'scheduled');
  assert.equal(completedDetails?.scheduleId, scheduleId);
  assert.equal(completedDetails?.commandId, null);
  assert.equal(Number(completedDetails?.actualGrams), 39.5);
  assert.equal(completedDetails?.errorMessage, null);

  const failedDetails = failed.kind === 'created'
    ? await repository.find(deviceId, failed.event.feedingId)
    : null;
  assert.equal(failedDetails?.status, 'failed');
  assert.equal(failedDetails?.errorCode, 'MOTOR_ERROR');
  assert.equal(failedDetails?.errorMessage, 'Motor is blocked');
  assert.equal(await repository.find(randomUUID(), values.feedingId), null);
  assert.equal(await repository.find(deviceId, randomUUID()), null);
});
