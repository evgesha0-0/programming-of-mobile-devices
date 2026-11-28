import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import test, { type TestContext } from 'node:test';

import { HttpBackendGateway } from '../../src/adapters/backend-http/index.js';
import { loadRuntimeConfig, RuntimeConfigurationError } from '../../src/config/index.js';
import { commandIdSchema, feedingIdSchema, scheduleIdSchema } from '../../src/domain/index.js';

const backendDirectory = new URL('../../../backend/', import.meta.url);
const backendRequire = createRequire(new URL('package.json', backendDirectory));
const backendUrl = 'https://backend.example.test';
const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const otherDeviceId = '76b0bed8-f162-486f-94b2-c5f2d1d97d4f';
const devicePath = `/api/v1/devices/${deviceId}`;
const deviceToken = `dvc_${Buffer.alloc(32, 1).toString('base64url')}`;
const androidToken = `usr_${Buffer.alloc(32, 2).toString('base64url')}`;
const reportedAt = '2026-11-21T06:00:00.125Z';
const environment = {
  NODE_ENV: 'test', BACKEND_URL: backendUrl, DEVICE_ID: deviceId,
  DEVICE_TOKEN: deviceToken, ANDROID_TOKEN: androidToken, SQLITE_PATH: './data/contract.sqlite',
};

test('Linux credentials do not fall back to or accept an Android token', () => {
  assert.equal(loadRuntimeConfig(environment).deviceToken, deviceToken);
  for (const token of [undefined, androidToken]) {
    assert.throws(() => loadRuntimeConfig({ ...environment, DEVICE_TOKEN: token }), (error) => (
      error instanceof RuntimeConfigurationError && !String(error).includes(androidToken)
    ));
  }
});

test('six Khadas operations match the real backend routes and credential boundaries', {
  skip: backendSkipReason(), timeout: 30_000,
}, async (t) => {
  const { app, db } = await createBackend(t);
  const androidHeaders = { authorization: `Bearer ${androidToken}`, 'content-type': 'application/json' };
  const schedule = {
    time_local: '08:30:00', days_of_week: ['mon', 'fri'], timezone: 'Asia/Yekaterinburg',
    portion_grams: 40, active: true,
  };
  const createdSchedule = await app.inject({
    method: 'POST', url: `${devicePath}/schedules`, headers: androidHeaders, payload: JSON.stringify(schedule),
  });
  assert.equal(createdSchedule.statusCode, 201, createdSchedule.payload);
  const savedSchedule = createdSchedule.json<{ schedule_id: string; schedule_revision: number; updated_at: string }>();
  const scheduleId = scheduleIdSchema.parse(savedSchedule.schedule_id);

  const commandId = commandIdSchema.parse(randomUUID());
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  const createdCommand = await app.inject({
    method: 'POST', url: `${devicePath}/feeding-commands`, headers: androidHeaders,
    payload: JSON.stringify({ command_id: commandId, portion_grams: 40, expires_at: expiresAt }),
  });
  assert.equal(createdCommand.statusCode, 202, createdCommand.payload);
  const savedCommand = createdCommand.json<{ feeding_id: string; created_at: string }>();
  const feedingId = feedingIdSchema.parse(savedCommand.feeding_id);

  const wire: Array<BackendRequest & { statusCode: number }> = [];
  const config = loadRuntimeConfig({ ...environment, DEVICE_ID: deviceId.toUpperCase() });
  const gateway = new HttpBackendGateway({
    ...config, backoffInitialMs: config.backoff.initialMs, backoffMaxMs: config.backoff.maxMs,
    maxAttempts: 1,
    async fetchImplementation(input, init) {
      const url = new URL(String(input));
      const request = {
        method: init?.method ?? 'GET',
        url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(new Headers(init?.headers)),
        payload: typeof init?.body === 'string' ? init.body : undefined,
      };
      const reply = await app.inject(request);
      wire.push({ ...request, statusCode: reply.statusCode });
      const headers = new Headers();
      for (const [name, value] of Object.entries(reply.headers)) {
        if (value !== undefined) headers.set(name, String(value));
      }
      return new Response(reply.payload, { status: reply.statusCode, headers });
    },
  });
  t.after(() => gateway.close());

  const heartbeat = {
    status: 'online', reported_at: reportedAt, firmware_version: '0.1.0', error_code: null, error_message: null,
  } as const;
  const sentAt = Date.now();
  const { data: { server_time: serverTime, ...state } } = await gateway.reportState(heartbeat);
  assert.deepEqual(state, {
    device_id: deviceId, status: 'online', last_seen_at: reportedAt,
  });
  assert.equal(new Date(serverTime).toISOString(), serverTime);
  assert.ok(Date.parse(serverTime) >= sentAt && Date.parse(serverTime) <= Date.now());
  const { data: snapshot } = await gateway.syncSchedules(0);
  assert.equal(snapshot.device_id, deviceId);
  assert.equal(snapshot.schedule_revision, savedSchedule.schedule_revision);
  assert.equal(new Date(snapshot.generated_at).toISOString(), snapshot.generated_at);
  assert.deepEqual(snapshot.items, [{
    ...schedule, schedule_id: scheduleId, updated_at: savedSchedule.updated_at, deleted_at: null,
  }]);
  const { data: pending } = await gateway.getPendingCommands(2);
  assert.deepEqual(pending.items, [{
    command_id: commandId, feeding_id: feedingId, device_id: deviceId, portion_grams: 40,
    status: 'pending', created_at: savedCommand.created_at, expires_at: expiresAt,
  }]);
  assert.equal(new Date(pending.server_time).toISOString(), pending.server_time);
  assert.ok(Date.parse(savedCommand.created_at) <= Date.parse(pending.server_time));
  assert.ok(Date.parse(pending.server_time) < Date.parse(expiresAt));

  const ack = { feeding_id: feedingId, status: 'running', started_at: savedCommand.created_at } as const;
  assert.deepEqual((await gateway.acknowledgeCommand(commandId, ack)).data, { command_id: commandId, ...ack });
  const manualResult = {
    command_id: commandId, source: 'manual', portion_grams: 40, actual_grams: 39.5, status: 'completed',
    started_at: ack.started_at, finished_at: new Date(Date.parse(ack.started_at) + 2_125).toISOString(),
    error_code: null, error_message: null,
  } as const;
  assert.deepEqual((await gateway.reportManualFeedingResult(feedingId, manualResult)).data, {
    feeding_id: feedingId, command_id: commandId, status: 'completed', actual_grams: 39.5,
    finished_at: manualResult.finished_at,
  });
  const scheduledEvent = {
    feeding_id: feedingIdSchema.parse(randomUUID()), schedule_id: scheduleId, source: 'scheduled',
    portion_grams: 40, actual_grams: 40.25, status: 'completed',
    created_at: new Date(Date.parse(ack.started_at) - 1_000).toISOString(),
    started_at: ack.started_at, finished_at: manualResult.finished_at, error_code: null, error_message: null,
  } as const;
  const { data: acceptedEvent } = await gateway.reportScheduledFeedingEvent(scheduledEvent);
  assert.equal(new Date(acceptedEvent.received_at).toISOString(), acceptedEvent.received_at);
  assert.deepEqual(acceptedEvent, {
    feeding_id: scheduledEvent.feeding_id, device_id: deviceId, schedule_id: scheduleId, source: 'scheduled',
    status: 'completed', actual_grams: 40.25, received_at: acceptedEvent.received_at,
  });
  assert.deepEqual((await gateway.reportScheduledFeedingEvent(scheduledEvent)).data, acceptedEvent);

  assert.deepEqual(wire.map(({ method, url, statusCode, payload }) => (
    [method, url, statusCode, payload === undefined ? undefined : JSON.parse(payload)]
  )), [
    ['PUT', `${devicePath}/state`, 200, heartbeat],
    ['GET', `${devicePath}/sync/schedules?known_revision=0`, 200, undefined],
    ['GET', `${devicePath}/commands/pending?limit=2`, 200, undefined],
    ['POST', `${devicePath}/commands/${commandId}/ack`, 200, ack],
    ['POST', `${devicePath}/feedings/${feedingId}/result`, 200, manualResult],
    ['POST', `${devicePath}/feeding-events`, 201, scheduledEvent],
    ['POST', `${devicePath}/feeding-events`, 200, scheduledEvent],
  ]);
  for (const { method, url, headers, payload } of wire.slice(0, 6)) {
    assert.equal(headers.authorization, `Bearer ${deviceToken}`);
    assert.equal(headers.accept, 'application/json');
    if (payload) assert.equal(headers['content-type']?.split(';', 1)[0], 'application/json');
    await assertBackendError(app, {
      method, url, payload, headers: { ...headers, authorization: `Bearer ${androidToken}` },
    }, 401, 'UNAUTHORIZED');
  }
  await assertBackendError(app, {
    method: 'GET', url: `${devicePath}/state`, headers: { authorization: `Bearer ${deviceToken}` },
  }, 401, 'UNAUTHORIZED');
  await assertBackendError(app, {
    method: 'GET', url: `/api/v1/devices/${otherDeviceId}/commands/pending?limit=2`,
    headers: { authorization: `Bearer ${deviceToken}` },
  }, 403, 'FORBIDDEN');
  await assertBackendError(app, {
    method: 'POST', url: `${devicePath}/commands/${commandId}/ack`,
    headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ ...ack, started_at: 'not-a-timestamp' }),
  }, 400, 'VALIDATION_ERROR');
  await assert.rejects(gateway.acknowledgeCommand(commandIdSchema.parse(randomUUID()), ack), {
    name: 'BackendHttpError', statusCode: 404, backendCode: 'NOT_FOUND', requestId: /.+/,
  });
  await assert.rejects(gateway.reportManualFeedingResult(feedingId, { ...manualResult, command_id: commandIdSchema.parse(randomUUID()) }), {
    name: 'BackendConflictError', statusCode: 409, backendCode: 'CONFLICT', requestId: /.+/,
  });
  await assert.rejects(gateway.reportScheduledFeedingEvent({ ...scheduledEvent, actual_grams: 41 }), {
    name: 'BackendConflictError', statusCode: 409, backendCode: 'CONFLICT', requestId: /.+/,
  });
  const { rows } = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM feedings WHERE device_id = $1', [deviceId]);
  assert.deepEqual(rows, [{ count: 2 }]);
});

interface BackendRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  payload?: string | undefined;
}

interface BackendApp {
  inject(request: BackendRequest): Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | number | undefined>;
    payload: string;
    json<T>(): T;
  }>;
  close(): Promise<void>;
}

interface Database {
  query<T = unknown>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

function backendSkipReason(): false | string {
  if (!existsSync(new URL('src/app.ts', backendDirectory))) return 'The backend workspace is not present';
  try {
    backendRequire.resolve('fastify');
    backendRequire.resolve('@electric-sql/pglite');
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    return 'Install backend dev dependencies to run the wire contract';
  }
}

async function createBackend(t: TestContext): Promise<{ app: BackendApp; db: Database }> {
  // Load the sibling workspace only for this test, without adding it to the Linux build.
  const load = (module: string) => import(new URL(`src/${module}.ts`, backendDirectory).href);
  const [
    { buildApp }, { runMigrations }, { createDeviceRepository }, { createScheduleRepository },
    { createCommandRepository }, { createFeedingRepository },
    { createDeviceAuthenticator }, { createDeviceAuthenticationRepository },
    { createUserAuthenticator }, { createUserAuthenticationRepository },
  ] = await Promise.all([
    load('app'), load('db/migrations'), load('devices/device.repository'), load('schedules/schedule.repository'),
    load('commands/command.repository'), load('feedings/feeding.repository'),
    load('authentication/device-authentication.service'), load('authentication/device-authentication.repository'),
    load('authentication/user-authentication.service'), load('authentication/user-authentication.repository'),
  ]);
  const { PGlite } = backendRequire('@electric-sql/pglite') as { PGlite: new () => Database };
  const db = new PGlite();
  let app: BackendApp | undefined;
  t.after(async () => {
    try { await app?.close(); } finally { await db.close(); }
  });
  await runMigrations({
    async query(sql: string, values?: unknown[]) {
      if (values || sql.trimStart().startsWith('SELECT')) return db.query(sql, values);
      await db.exec(sql);
      return { rows: [] };
    },
  });
  const connection = { query: db.query.bind(db), release() {} };
  const pool = { ...connection, async connect() { return connection; } };
  const userId = randomUUID();
  const hash = (token: string) => createHash('sha256').update(token).digest('hex');
  await db.query('INSERT INTO devices(device_id, name) VALUES ($1, $2)', [deviceId, 'Contract feeder']);
  await db.query('INSERT INTO users(user_id) VALUES ($1)', [userId]);
  await db.query('INSERT INTO user_devices(user_device_id, user_id, device_id, role) VALUES ($1, $2, $3, $4)',
    [randomUUID(), userId, deviceId, 'owner']);
  await db.query(`INSERT INTO device_credentials(credential_id, device_id, token_hash, token_hint)
    VALUES ($1, $2, decode($3, 'hex'), left($3, 12))`, [randomUUID(), deviceId, hash(deviceToken)]);
  await db.query(`INSERT INTO user_credentials(credential_id, user_id, token_hash, token_hint)
    VALUES ($1, $2, decode($3, 'hex'), left($3, 12))`, [randomUUID(), userId, hash(androidToken)]);

  const backend: BackendApp = await buildApp({
    checkDatabase: async () => undefined,
    commandRepository: createCommandRepository(pool),
    deviceRepository: createDeviceRepository(pool),
    feedingRepository: createFeedingRepository(pool),
    scheduleRepository: createScheduleRepository(pool),
    deviceAuthenticator: createDeviceAuthenticator(createDeviceAuthenticationRepository(pool)),
    userAuthenticator: createUserAuthenticator(createUserAuthenticationRepository(pool)),
  });
  app = backend;
  return { app, db };
}

async function assertBackendError(app: BackendApp, request: BackendRequest, status: 400 | 401 | 403, code: string): Promise<void> {
  const response = await app.inject(request);
  assert.equal(response.statusCode, status, `${request.method} ${request.url}`);
  assert.equal(response.headers['www-authenticate'], status === 401 ? 'Bearer' : undefined);
  const { error } = response.json<{ error: { code: string; request_id: string } }>();
  assert.equal(error.code, code);
  assert.ok(error.request_id);
}
