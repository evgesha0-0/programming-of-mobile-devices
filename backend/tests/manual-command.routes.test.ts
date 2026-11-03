import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommandRepository } from '../src/commands/command.repository.js';
import type {
  ManualCommandRecord,
  ManualCommandValues,
  ManualFeedingResultRecord,
  ManualFeedingResultValues,
} from '../src/commands/command.types.js';
import type { DeviceRepository } from '../src/devices/device.repository.js';
import type { FeedingRepository } from '../src/feedings/feeding.repository.js';
import type { ScheduleRepository } from '../src/schedules/schedule.repository.js';

const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const missingDeviceId = '4d6b9594-9278-4621-88f3-876b3d127fd8';
const commandId = '1875723f-f6e1-4307-92c8-81577f1ea2fb';

const unusedDeviceRepository: DeviceRepository = {
  async findState() { throw new Error('Device repository must not be used by command routes'); },
  async updateStateIfNewer() { throw new Error('Device repository must not be used by command routes'); },
};

const unusedScheduleRepository: ScheduleRepository = {
  async list() { throw new Error('Schedule repository must not be used by command routes'); },
  async sync() { throw new Error('Schedule repository must not be used by command routes'); },
  async create() { throw new Error('Schedule repository must not be used by command routes'); },
  async update() { throw new Error('Schedule repository must not be used by command routes'); },
  async delete() { throw new Error('Schedule repository must not be used by command routes'); },
};
const unusedFeedingRepository: FeedingRepository = {
  async createScheduledEvent() { throw new Error('Feeding repository must not be used by command routes'); },
  async find() { throw new Error('Feeding repository must not be used by command routes'); },
  async list() { throw new Error('Feeding repository must not be used by command routes'); },
};

function memoryRepository(): CommandRepository {
  const commands = new Map<string, ManualCommandRecord>();
  const results = new Map<string, {
    values: ManualFeedingResultValues;
    result: ManualFeedingResultRecord;
  }>();
  const serverTime = new Date('2026-11-03T06:00:00Z');

  return {
    async create(values) {
      if (values.deviceId !== deviceId) return { kind: 'device_not_found' };
      const existing = commands.get(values.commandId);
      if (existing) {
        return sameCommand(existing, values)
          ? { kind: 'repeated', command: existing }
          : { kind: 'conflict' };
      }
      if (values.expiresAt <= values.createdAt) return { kind: 'invalid_expiry' };

      const command: ManualCommandRecord = {
        commandId: values.commandId,
        feedingId: values.feedingId,
        deviceId: values.deviceId,
        portionGrams: values.portionGrams.toFixed(2),
        status: 'pending',
        createdAt: values.createdAt,
        expiresAt: values.expiresAt,
        startedAt: null,
        finishedAt: null,
        actualGrams: null,
        errorCode: null,
      };
      commands.set(values.commandId, command);
      return { kind: 'created', command };
    },
    async listPending(id, limit) {
      if (id !== deviceId) return { kind: 'device_not_found' };
      for (const [id, command] of commands) {
        if (command.status === 'pending' && command.expiresAt <= serverTime) {
          commands.set(id, {
            ...command,
            status: 'expired',
            finishedAt: serverTime,
          });
        }
      }
      return {
        kind: 'found',
        commands: {
          serverTime,
          items: [...commands.values()]
            .filter((command) => command.status === 'pending')
            .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
            .slice(0, limit)
            .map((command) => ({
              commandId: command.commandId,
              feedingId: command.feedingId,
              deviceId: command.deviceId,
              portionGrams: command.portionGrams,
              status: 'pending' as const,
              createdAt: command.createdAt,
              expiresAt: command.expiresAt,
            })),
        },
      };
    },
    async acknowledge(values) {
      if (values.deviceId !== deviceId) return { kind: 'not_found' };
      const command = commands.get(values.commandId);
      if (!command) return { kind: 'not_found' };
      if (command.feedingId !== values.feedingId) return { kind: 'conflict' };
      if (command.status === 'running') {
        return command.startedAt?.getTime() === values.startedAt.getTime()
          ? {
              kind: 'acknowledged',
              command: {
                commandId: command.commandId,
                feedingId: command.feedingId,
                status: 'running',
                startedAt: values.startedAt,
              },
            }
          : { kind: 'conflict' };
      }
      if (command.status !== 'pending') return { kind: 'conflict' };
      if (command.expiresAt <= serverTime) {
        commands.set(command.commandId, {
          ...command,
          status: 'expired',
          finishedAt: serverTime,
        });
        return { kind: 'conflict' };
      }
      if (values.startedAt < command.createdAt) return { kind: 'invalid_started_at' };

      commands.set(command.commandId, {
        ...command,
        status: 'running',
        startedAt: values.startedAt,
      });
      return {
        kind: 'acknowledged',
        command: {
          commandId: command.commandId,
          feedingId: command.feedingId,
          status: 'running',
          startedAt: values.startedAt,
        },
      };
    },
    async submitResult(values) {
      if (values.deviceId !== deviceId) return { kind: 'not_found' };
      const command = [...commands.values()].find(
        (candidate) => candidate.feedingId === values.feedingId,
      );
      if (!command) return { kind: 'not_found' };
      const identityMatches = command.commandId === values.commandId
        && Number(command.portionGrams) === values.portionGrams
        && command.startedAt?.getTime() === values.startedAt.getTime();
      if (!identityMatches) return { kind: 'conflict' };
      if (values.finishedAt < values.startedAt) return { kind: 'invalid_timeline' };

      const existing = results.get(values.feedingId);
      if (existing) {
        return sameResult(existing.values, values)
          ? { kind: 'accepted', result: existing.result }
          : { kind: 'conflict' };
      }
      if (command.status !== 'running') return { kind: 'conflict' };

      const result: ManualFeedingResultRecord = {
        feedingId: values.feedingId,
        commandId: values.commandId,
        status: values.status,
        actualGrams: values.actualGrams === null ? null : values.actualGrams.toFixed(2),
        finishedAt: values.finishedAt,
      };
      results.set(values.feedingId, { values, result });
      commands.set(command.commandId, {
        ...command,
        status: values.status,
        actualGrams: result.actualGrams,
        finishedAt: values.finishedAt,
        errorCode: values.errorCode,
      });
      return { kind: 'accepted', result };
    },
  };
}

async function appWith(commandRepository = memoryRepository()) {
  return buildApp({
    checkDatabase: async () => undefined,
    commandRepository,
    deviceRepository: unusedDeviceRepository,
    feedingRepository: unusedFeedingRepository,
    scheduleRepository: unusedScheduleRepository,
  });
}

const validCommand = {
  command_id: commandId,
  portion_grams: 40,
  expires_at: '2099-10-29T03:00:00Z',
};

test('manual command returns 202 when created and 200 for an exact repeat', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const created = await app.inject({
    method: 'POST', url: `/api/v1/devices/${deviceId}/feeding-commands`, payload: validCommand,
  });
  assert.equal(created.statusCode, 202);
  const body = created.json();
  assert.equal(body.command_id, commandId);
  assert.equal(body.device_id, deviceId);
  assert.equal(body.source, 'manual');
  assert.equal(body.portion_grams, 40);
  assert.equal(body.status, 'pending');
  assert.match(body.feeding_id, /^[0-9a-f-]{36}$/);
  assert.equal(body.actual_grams, null);

  const repeated = await app.inject({
    method: 'POST', url: `/api/v1/devices/${deviceId}/feeding-commands`, payload: validCommand,
  });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().feeding_id, body.feeding_id);
  assert.equal(repeated.json().created_at, body.created_at);
});

test('manual command rejects conflicting content under the same command_id', async (t) => {
  const app = await appWith();
  t.after(() => app.close());
  await app.inject({
    method: 'POST', url: `/api/v1/devices/${deviceId}/feeding-commands`, payload: validCommand,
  });

  const conflict = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-commands`,
    payload: { ...validCommand, portion_grams: 50 },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'CONFLICT');
});

test('manual command validates input, expiry and device existence', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  for (const payload of [
    { ...validCommand, command_id: 'not-a-uuid' },
    { ...validCommand, portion_grams: 0 },
    { ...validCommand, portion_grams: 10.001 },
    { ...validCommand, expires_at: 'not-a-date' },
    { ...validCommand, extra: true },
  ]) {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/devices/${deviceId}/feeding-commands`, payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }

  const expired = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-commands`,
    payload: { ...validCommand, command_id: '693df286-f089-463e-848d-5a19f7027449', expires_at: '2000-01-01T00:00:00Z' },
  });
  assert.equal(expired.statusCode, 400);
  assert.equal(expired.json().error.code, 'VALIDATION_ERROR');

  const missing = await app.inject({
    method: 'POST', url: `/api/v1/devices/${missingDeviceId}/feeding-commands`, payload: validCommand,
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'NOT_FOUND');
});

test('pending commands use the default limit and return the Linux contract', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const first = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-commands`,
    payload: validCommand,
  });
  const second = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-commands`,
    payload: {
      ...validCommand,
      command_id: '693df286-f089-463e-848d-5a19f7027449',
      portion_grams: 25,
    },
  });

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${deviceId}/commands/pending`,
  });

  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 202);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().server_time, '2026-11-03T06:00:00.000Z');
  assert.equal(response.json().items.length, 2);
  assert.deepEqual(response.json().items[0], {
    command_id: commandId,
    feeding_id: first.json().feeding_id,
    device_id: deviceId,
    portion_grams: 40,
    status: 'pending',
    created_at: first.json().created_at,
    expires_at: '2099-10-29T03:00:00.000Z',
  });
});

test('pending commands enforce limit and validate query parameters', async (t) => {
  const app = await appWith();
  t.after(() => app.close());
  await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-commands`,
    payload: validCommand,
  });
  await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-commands`,
    payload: { ...validCommand, command_id: '693df286-f089-463e-848d-5a19f7027449' },
  });

  const limited = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${deviceId}/commands/pending?limit=1`,
  });
  assert.equal(limited.statusCode, 200);
  assert.equal(limited.json().items.length, 1);

  for (const query of ['limit=0', 'limit=-1', 'limit=1.5', 'limit=unknown', 'limit=1&extra=1']) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceId}/commands/pending?${query}`,
    });
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }
});

test('pending commands return not found for an unknown device', async (t) => {
  const app = await appWith();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/devices/${missingDeviceId}/commands/pending?limit=10`,
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'NOT_FOUND');
});

test('command acknowledgment moves a pending command to running and is idempotent', async (t) => {
  const app = await appWith();
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-commands`,
    payload: validCommand,
  });
  const acknowledgment = {
    feeding_id: created.json().feeding_id,
    status: 'running',
    started_at: '2090-01-01T00:00:00Z',
  };

  const first = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/commands/${commandId}/ack`,
    payload: acknowledgment,
  });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), {
    command_id: commandId,
    feeding_id: created.json().feeding_id,
    status: 'running',
    started_at: '2090-01-01T00:00:00.000Z',
  });

  const repeated = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/commands/${commandId}/ack`,
    payload: acknowledgment,
  });
  assert.equal(repeated.statusCode, 200);
  assert.deepEqual(repeated.json(), first.json());
});

test('command acknowledgment rejects mismatched identity and conflicting repeats', async (t) => {
  const app = await appWith();
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-commands`,
    payload: validCommand,
  });
  const acknowledgment = {
    feeding_id: created.json().feeding_id,
    status: 'running',
    started_at: '2090-01-01T00:00:00Z',
  };

  const wrongFeeding = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/commands/${commandId}/ack`,
    payload: { ...acknowledgment, feeding_id: 'ebc2fd74-7272-4c9e-a416-bdffde906913' },
  });
  assert.equal(wrongFeeding.statusCode, 409);
  assert.equal(wrongFeeding.json().error.code, 'CONFLICT');

  const accepted = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/commands/${commandId}/ack`,
    payload: acknowledgment,
  });
  assert.equal(accepted.statusCode, 200);

  const conflictingRepeat = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/commands/${commandId}/ack`,
    payload: { ...acknowledgment, started_at: '2090-01-01T00:00:01Z' },
  });
  assert.equal(conflictingRepeat.statusCode, 409);
  assert.equal(conflictingRepeat.json().error.code, 'CONFLICT');
});

test('command acknowledgment validates request and returns not found', async (t) => {
  const app = await appWith();
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-commands`,
    payload: validCommand,
  });
  const body = {
    feeding_id: created.json().feeding_id,
    status: 'running',
    started_at: '2090-01-01T00:00:00Z',
  };

  for (const payload of [
    { ...body, feeding_id: 'not-a-uuid' },
    { ...body, status: 'pending' },
    { ...body, started_at: 'not-a-date' },
    { ...body, extra: true },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/commands/${commandId}/ack`,
      payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }

  const invalidStartedAt = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/commands/${commandId}/ack`,
    payload: { ...body, started_at: '2000-01-01T00:00:00Z' },
  });
  assert.equal(invalidStartedAt.statusCode, 400);
  assert.equal(invalidStartedAt.json().error.code, 'VALIDATION_ERROR');

  const missing = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/commands/693df286-f089-463e-848d-5a19f7027449/ack`,
    payload: body,
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'NOT_FOUND');
});

test('completed manual result is saved and an exact repeat is idempotent', async (t) => {
  const app = await appWith();
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-commands`,
    payload: validCommand,
  });
  const startedAt = '2090-01-01T00:00:00Z';
  await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/commands/${commandId}/ack`,
    payload: {
      feeding_id: created.json().feeding_id,
      status: 'running',
      started_at: startedAt,
    },
  });
  const result = {
    command_id: commandId,
    source: 'manual',
    portion_grams: 40,
    actual_grams: 39.5,
    status: 'completed',
    started_at: startedAt,
    finished_at: '2090-01-01T00:00:12Z',
    error_code: null,
    error_message: null,
  };

  const accepted = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feedings/${created.json().feeding_id}/result`,
    payload: result,
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json(), {
    feeding_id: created.json().feeding_id,
    command_id: commandId,
    status: 'completed',
    actual_grams: 39.5,
    finished_at: '2090-01-01T00:00:12.000Z',
  });

  const repeated = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feedings/${created.json().feeding_id}/result`,
    payload: result,
  });
  assert.equal(repeated.statusCode, 200);
  assert.deepEqual(repeated.json(), accepted.json());

  const conflict = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feedings/${created.json().feeding_id}/result`,
    payload: { ...result, actual_grams: 38 },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'CONFLICT');
});

test('failed manual result accepts nullable weight and required error details', async (t) => {
  const app = await appWith();
  t.after(() => app.close());
  const failedCommandId = '693df286-f089-463e-848d-5a19f7027449';
  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-commands`,
    payload: { ...validCommand, command_id: failedCommandId, portion_grams: 25 },
  });
  const startedAt = '2090-02-01T00:00:00Z';
  await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/commands/${failedCommandId}/ack`,
    payload: {
      feeding_id: created.json().feeding_id,
      status: 'running',
      started_at: startedAt,
    },
  });

  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feedings/${created.json().feeding_id}/result`,
    payload: {
      command_id: failedCommandId,
      source: 'manual',
      portion_grams: 25,
      actual_grams: null,
      status: 'failed',
      started_at: startedAt,
      finished_at: '2090-02-01T00:00:05Z',
      error_code: 'MOTOR_ERROR',
      error_message: 'Motor is blocked',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    feeding_id: created.json().feeding_id,
    command_id: failedCommandId,
    status: 'failed',
    actual_grams: null,
    finished_at: '2090-02-01T00:00:05.000Z',
  });
});

test('manual result validates payload, timeline and current command state', async (t) => {
  const app = await appWith();
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feeding-commands`,
    payload: validCommand,
  });
  const base = {
    command_id: commandId,
    source: 'manual',
    portion_grams: 40,
    actual_grams: 39.5,
    status: 'completed',
    started_at: '2090-01-01T00:00:00Z',
    finished_at: '2090-01-01T00:00:12Z',
    error_code: null,
    error_message: null,
  };

  for (const payload of [
    { ...base, source: 'scheduled' },
    { ...base, actual_grams: null },
    { ...base, error_code: 'UNEXPECTED' },
    { ...base, portion_grams: 10.001 },
    { ...base, extra: true },
    {
      ...base,
      status: 'failed',
      actual_grams: null,
      error_code: '   ',
      error_message: 'Motor is blocked',
    },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/feedings/${created.json().feeding_id}/result`,
      payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }

  const pendingConflict = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feedings/${created.json().feeding_id}/result`,
    payload: base,
  });
  assert.equal(pendingConflict.statusCode, 409);
  assert.equal(pendingConflict.json().error.code, 'CONFLICT');

  await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/commands/${commandId}/ack`,
    payload: {
      feeding_id: created.json().feeding_id,
      status: 'running',
      started_at: base.started_at,
    },
  });
  const invalidTimeline = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feedings/${created.json().feeding_id}/result`,
    payload: { ...base, finished_at: '2089-12-31T23:59:59Z' },
  });
  assert.equal(invalidTimeline.statusCode, 400);
  assert.equal(invalidTimeline.json().error.code, 'VALIDATION_ERROR');

  const missing = await app.inject({
    method: 'POST',
    url: `/api/v1/devices/${deviceId}/feedings/ebc2fd74-7272-4c9e-a416-bdffde906913/result`,
    payload: base,
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'NOT_FOUND');
});

function sameResult(left: ManualFeedingResultValues, right: ManualFeedingResultValues): boolean {
  return left.deviceId === right.deviceId
    && left.feedingId === right.feedingId
    && left.commandId === right.commandId
    && left.source === right.source
    && left.portionGrams === right.portionGrams
    && left.actualGrams === right.actualGrams
    && left.status === right.status
    && left.startedAt.getTime() === right.startedAt.getTime()
    && left.finishedAt.getTime() === right.finishedAt.getTime()
    && left.errorCode === right.errorCode
    && left.errorMessage === right.errorMessage;
}

function sameCommand(command: ManualCommandRecord, values: ManualCommandValues): boolean {
  return command.deviceId === values.deviceId
    && Number(command.portionGrams) === values.portionGrams
    && command.expiresAt.getTime() === values.expiresAt.getTime();
}

