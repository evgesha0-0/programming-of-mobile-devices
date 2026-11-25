import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import { createUserAuthenticationRepository } from '../src/authentication/user-authentication.repository.js';
import { createUserAuthenticator } from '../src/authentication/user-authentication.service.js';
import { runMigrations, type MigrationConnection } from '../src/db/migrations.js';
import {
  createUserProvisioningRepository,
  type NewOwnerValues,
  type ProvisionOwnerResult,
  type UserProvisioningDatabase,
  type UserProvisioningRepository,
} from '../src/provisioning/user-provisioning.repository.js';
import {
  createUserProvisioningService,
  UserProvisioningDeviceNotFoundError,
  UserProvisioningOwnerExistsError,
  UserProvisioningValidationError,
  type UserProvisioningRandom,
} from '../src/provisioning/user-provisioning.service.js';

const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const credentialId = '1875723f-f6e1-4307-92c8-81577f1ea2fb';
const userId = 'fcba4f1c-7cf2-43de-b60f-97be27b5b7dc';
const userDeviceId = '723fb100-1524-44e4-8b0a-b91fc6eb0964';

test('owner provisioning returns usr token once and stores only its hash', async () => {
  const storage = memoryRepository();
  const service = createUserProvisioningService(
    storage,
    deterministicRandom([credentialId, userId, userDeviceId], 7),
  );

  const result = await service.provisionOwner(deviceId);

  assert.deepEqual({
    userId: result.userId,
    deviceId: result.deviceId,
    role: result.role,
  }, { userId, deviceId, role: 'owner' });
  assert.match(result.userToken, /^usr_[A-Za-z0-9_-]{43}$/);
  const stored = storage.created[0];
  assert.equal(stored?.userId, userId);
  assert.equal(stored?.deviceId, deviceId);
  assert.equal(stored?.userDeviceId, userDeviceId);
  assert.equal('userToken' in (stored ?? {}), false);
  const expectedHash = createHash('sha256').update(result.userToken, 'utf8').digest();
  assert.deepEqual(stored?.credential.tokenHash, expectedHash);
  assert.equal(stored?.credential.tokenHint, expectedHash.subarray(0, 6).toString('hex'));
});

test('owner provisioning validates IDs and maps repository outcomes', async () => {
  const storage = memoryRepository();
  const invalidService = createUserProvisioningService(
    storage,
    deterministicRandom([credentialId, userId, userDeviceId], 8),
  );

  await assert.rejects(invalidService.provisionOwner('not-a-uuid'), UserProvisioningValidationError);
  assert.equal(storage.created.length, 0);

  storage.result = 'device_not_found';
  await assert.rejects(createUserProvisioningService(
    storage,
    deterministicRandom([credentialId, userId, userDeviceId], 8),
  ).provisionOwner(deviceId), UserProvisioningDeviceNotFoundError);

  storage.result = 'owner_exists';
  await assert.rejects(createUserProvisioningService(
    storage,
    deterministicRandom([
      'a136eb7a-c8a3-4d31-a25c-f61337241f6c',
      '2b3ecbf9-4885-4368-93ee-7b6151406bc5',
      'f1467e18-c6da-40f9-8cef-7582e56e0940',
    ], 9),
  ).provisionOwner(deviceId), UserProvisioningOwnerExistsError);
});

test('repository creates authenticatable owner records in one transaction', async (t) => {
  const database = new PGlite();
  t.after(() => database.close());
  await runMigrations(migrationConnection(database));
  await database.query(
    'INSERT INTO devices(device_id, name) VALUES ($1, $2)',
    [deviceId, 'Integration feeder'],
  );
  const provisioningDatabase = transactionDatabase(database);
  const service = createUserProvisioningService(
    createUserProvisioningRepository(provisioningDatabase),
    deterministicRandom([credentialId, userId, userDeviceId], 9),
  );

  const issued = await service.provisionOwner(deviceId);

  assert.equal((await database.query('SELECT * FROM users WHERE user_id = $1', [userId])).rows.length, 1);
  assert.equal((await database.query(
    `SELECT * FROM user_devices
     WHERE user_id = $1 AND device_id = $2 AND role = 'owner' AND revoked_at IS NULL`,
    [userId, deviceId],
  )).rows.length, 1);
  const credentials = await database.query<{
    token_hash: Uint8Array;
    token_hint: string;
  }>('SELECT token_hash, token_hint FROM user_credentials WHERE user_id = $1', [userId]);
  const expectedHash = createHash('sha256').update(issued.userToken, 'utf8').digest();
  assert.deepEqual(Buffer.from(credentials.rows[0]?.token_hash ?? []), expectedHash);
  assert.equal(credentials.rows[0]?.token_hint, expectedHash.subarray(0, 6).toString('hex'));

  const authenticator = createUserAuthenticator(
    createUserAuthenticationRepository(provisioningDatabase),
  );
  const identity = await authenticator.authenticate(
    `Bearer ${issued.userToken}`,
    deviceId,
    'owner',
  );
  assert.equal(identity.userId, userId);
  assert.equal(identity.deviceId, deviceId);
  assert.equal(identity.role, 'owner');
});

test('repository refuses a second owner and rolls back credential conflicts', async (t) => {
  const database = new PGlite();
  t.after(() => database.close());
  await runMigrations(migrationConnection(database));
  const firstDevice = deviceId;
  const secondDevice = '76b0bed8-f162-486f-94b2-c5f2d1d97d4f';
  await database.query(
    'INSERT INTO devices(device_id, name) VALUES ($1, $2), ($3, $4)',
    [firstDevice, 'First feeder', secondDevice, 'Second feeder'],
  );
  const provisioningDatabase = transactionDatabase(database);
  const repository = createUserProvisioningRepository(provisioningDatabase);
  const firstService = createUserProvisioningService(
    repository,
    deterministicRandom([credentialId, userId, userDeviceId], 10),
  );
  await firstService.provisionOwner(firstDevice);

  const secondOwnerService = createUserProvisioningService(
    repository,
    deterministicRandom([
      'a136eb7a-c8a3-4d31-a25c-f61337241f6c',
      '2b3ecbf9-4885-4368-93ee-7b6151406bc5',
      'f1467e18-c6da-40f9-8cef-7582e56e0940',
    ], 11),
  );
  await assert.rejects(
    secondOwnerService.provisionOwner(firstDevice),
    UserProvisioningOwnerExistsError,
  );
  assert.equal((await database.query('SELECT * FROM users')).rows.length, 1);

  const conflictingUserId = 'dca8de88-3071-44c6-adb8-c00c783ef585';
  const conflictService = createUserProvisioningService(
    repository,
    deterministicRandom([
      '56450151-4fb9-453a-a459-3f1bed2f821b',
      conflictingUserId,
      '08b1437c-b1f7-4a35-8668-a65e5ac9aca4',
    ], 10),
  );
  await assert.rejects(conflictService.provisionOwner(secondDevice));
  assert.equal((await database.query(
    'SELECT * FROM users WHERE user_id = $1',
    [conflictingUserId],
  )).rows.length, 0);
  assert.equal((await database.query(
    'SELECT * FROM user_devices WHERE device_id = $1',
    [secondDevice],
  )).rows.length, 0);
});

function deterministicRandom(
  identifiers: string[],
  byte: number,
): UserProvisioningRandom {
  const remaining = [...identifiers];
  return {
    uuid() {
      const value = remaining.shift();
      if (!value) throw new Error('No deterministic UUID left');
      return value;
    },
    bytes(size) {
      return Buffer.alloc(size, byte);
    },
  };
}

function memoryRepository(): UserProvisioningRepository & {
  created: NewOwnerValues[];
  result: ProvisionOwnerResult;
} {
  const storage: UserProvisioningRepository & {
    created: NewOwnerValues[];
    result: ProvisionOwnerResult;
  } = {
    created: [],
    result: 'created',
    async provisionOwner(values) {
      storage.created.push(values);
      return storage.result;
    },
  };
  return storage;
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

function transactionDatabase(database: PGlite): UserProvisioningDatabase {
  const query = async <R extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) {
      await database.exec(sql);
      return { rows: [] as R[] };
    }
    return database.query<R>(sql, values ? [...values] : undefined);
  };
  return {
    query,
    async connect() {
      return { query, release() {} };
    },
  };
}
