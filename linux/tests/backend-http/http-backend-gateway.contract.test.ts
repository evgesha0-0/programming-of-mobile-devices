import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpBackendGateway } from '../../src/adapters/backend-http/index.js';
import { createJsonLogger } from '../../src/observability/index.js';
import {
  BackendConfigurationError,
  BackendConflictError,
  BackendContractError,
  BackendCredentialError,
  BackendHttpError,
  BackendTransportError,
} from '../../src/ports/index.js';
import {
  commandIdSchema,
  deviceIdSchema,
  feedingIdSchema,
  scheduleIdSchema,
} from '../../src/domain/index.js';

const deviceIdValue = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const scheduleIdValue = '811f98b6-e0f9-40ad-9b5e-46d501f1a1d3';
const commandIdValue = 'a891f5dd-645c-4a98-b3b4-a8c3fd6f9dd7';
const feedingIdValue = 'a552a367-1de4-4381-a238-d93f1f1da654';
const deviceId = deviceIdSchema.parse(deviceIdValue);
const commandId = commandIdSchema.parse(commandIdValue);
const feedingId = feedingIdSchema.parse(feedingIdValue);
const scheduleId = scheduleIdSchema.parse(scheduleIdValue);
const deviceToken = `dvc_${'E'.repeat(43)}`;

test('gateway matches all six device endpoints from backend a965983', async () => {
  const queue = new FetchQueue([
    jsonResponse({
      device_id: deviceIdValue,
      status: 'online',
      last_seen_at: '2026-11-21T06:00:00.000Z',
      server_time: '2026-11-21T06:00:00.010Z',
    }, 200, 'req-state'),
    jsonResponse({
      device_id: deviceIdValue,
      schedule_revision: 12,
      generated_at: '2026-11-21T06:00:01.000Z',
      items: [{
        schedule_id: scheduleIdValue,
        time_local: '08:30:00',
        days_of_week: ['mon', 'wed', 'fri'],
        timezone: 'Asia/Yekaterinburg',
        portion_grams: 40,
        active: true,
        updated_at: '2026-11-21T05:59:00.000Z',
        deleted_at: null,
      }],
    }, 200, 'req-sync'),
    jsonResponse({
      items: [{
        command_id: commandIdValue,
        feeding_id: feedingIdValue,
        device_id: deviceIdValue,
        portion_grams: 40,
        status: 'pending',
        created_at: '2026-11-21T06:00:00.000Z',
        expires_at: '2026-11-21T06:10:00.000Z',
      }],
      server_time: '2026-11-21T06:00:02.000Z',
    }, 200, 'req-pending'),
    jsonResponse({
      command_id: commandIdValue,
      feeding_id: feedingIdValue,
      status: 'running',
      started_at: '2026-11-21T06:00:03.000Z',
    }, 200, 'req-ack'),
    jsonResponse({
      feeding_id: feedingIdValue,
      command_id: commandIdValue,
      status: 'completed',
      actual_grams: 39.5,
      finished_at: '2026-11-21T06:00:08.000Z',
    }, 200, 'req-result'),
    jsonResponse({
      feeding_id: feedingIdValue,
      device_id: deviceIdValue,
      schedule_id: scheduleIdValue,
      source: 'scheduled',
      status: 'completed',
      actual_grams: 40.25,
      received_at: '2026-11-21T06:00:09.000Z',
    }, 201, 'req-event'),
  ]);
  const gateway = createGateway(queue);

  const state = await gateway.reportState({
    status: 'online',
    reported_at: '2026-11-21T06:00:00.000Z',
    firmware_version: '0.1.0',
    error_code: null,
    error_message: null,
  });
  const schedules = await gateway.syncSchedules(11);
  const pending = await gateway.getPendingCommands(10);
  const acknowledged = await gateway.acknowledgeCommand(commandId, {
    feeding_id: feedingId,
    status: 'running',
    started_at: '2026-11-21T06:00:03.000Z',
  });
  const manualResult = await gateway.reportManualFeedingResult(feedingId, {
    command_id: commandId,
    source: 'manual',
    portion_grams: 40,
    actual_grams: 39.5,
    status: 'completed',
    started_at: '2026-11-21T06:00:03.000Z',
    finished_at: '2026-11-21T06:00:08.000Z',
    error_code: null,
    error_message: null,
  });
  const scheduledEvent = await gateway.reportScheduledFeedingEvent({
    feeding_id: feedingId,
    schedule_id: scheduleId,
    source: 'scheduled',
    portion_grams: 40,
    actual_grams: 40.25,
    status: 'completed',
    created_at: '2026-11-21T05:59:59.000Z',
    started_at: '2026-11-21T06:00:03.000Z',
    finished_at: '2026-11-21T06:00:08.000Z',
    error_code: null,
    error_message: null,
  });

  assert.equal(state.requestId, 'req-state');
  assert.equal(schedules.data.schedule_revision, 12);
  assert.equal(pending.data.items[0]?.command_id, commandIdValue);
  assert.equal(acknowledged.requestId, 'req-ack');
  assert.equal(manualResult.data.actual_grams, 39.5);
  assert.equal(scheduledEvent.requestId, 'req-event');
  assert.deepEqual(queue.requests.map((request) => request.method), [
    'PUT', 'GET', 'GET', 'POST', 'POST', 'POST',
  ]);
  assert.deepEqual(queue.requests.map((request) => new URL(request.url).pathname), [
    `/api/v1/devices/${deviceIdValue}/state`,
    `/api/v1/devices/${deviceIdValue}/sync/schedules`,
    `/api/v1/devices/${deviceIdValue}/commands/pending`,
    `/api/v1/devices/${deviceIdValue}/commands/${commandIdValue}/ack`,
    `/api/v1/devices/${deviceIdValue}/feedings/${feedingIdValue}/result`,
    `/api/v1/devices/${deviceIdValue}/feeding-events`,
  ]);
  assert.equal(new URL(queue.requests[1]?.url ?? '').search, '?known_revision=11');
  assert.equal(new URL(queue.requests[2]?.url ?? '').search, '?limit=10');
  for (const request of queue.requests) {
    assert.equal(request.headers.get('authorization'), `Bearer ${deviceToken}`);
    assert.equal(request.headers.get('accept'), 'application/json');
    assert.equal(request.redirect, 'error');
  }
  assert.equal(queue.requests[1]?.body, undefined);
  assert.equal(queue.requests[2]?.body, undefined);
  gateway.close();
});

test('gateway retries transport and retryable HTTP failures with the exact payload', async () => {
  const logLines: string[] = [];
  const delays: number[] = [];
  const queue = new FetchQueue([
    new TypeError(`transport failed ${deviceToken}`),
    jsonResponse(errorBody('SERVICE_UNAVAILABLE', 'req-503'), 503),
    jsonResponse({
      feeding_id: feedingIdValue,
      command_id: commandIdValue,
      status: 'completed',
      actual_grams: 39.5,
      finished_at: '2026-11-21T06:00:08.000Z',
    }, 200, 'req-success'),
  ]);
  const logger = createJsonLogger({
    level: 'debug',
    secrets: [deviceToken],
    sink: (line) => logLines.push(line),
  });
  const gateway = createGateway(queue, {
    logger,
    backoffInitialMs: 25,
    backoffMaxMs: 50,
    sleep: async (delayMs) => { delays.push(delayMs); },
  });
  const request = {
    command_id: commandId,
    source: 'manual' as const,
    portion_grams: 40,
    actual_grams: 39.5,
    status: 'completed' as const,
    started_at: '2026-11-21T06:00:03.000Z',
    finished_at: '2026-11-21T06:00:08.000Z',
    error_code: null,
    error_message: null,
  };

  const result = await gateway.reportManualFeedingResult(feedingId, request);

  assert.equal(result.requestId, 'req-success');
  assert.deepEqual(delays, [25, 50]);
  assert.equal(queue.requests.length, 3);
  assert.equal(new Set(queue.requests.map((entry) => entry.body)).size, 1);
  assert.equal(queue.requests[0]?.body, JSON.stringify(request));
  assert.equal(logLines.some((line) => line.includes(deviceToken)), false);
  gateway.close();
});

test('gateway retries only 408, 429 and 5xx responses', async () => {
  for (const status of [408, 429, 500, 503]) {
    const queue = new FetchQueue([
      jsonResponse(errorBody('RETRYABLE', `req-${status}`), status),
      validStateResponse(),
    ]);
    const gateway = createGateway(queue, { sleep: async () => {} });
    await gateway.reportState(validStateRequest());
    assert.equal(queue.requests.length, 2, `status ${status} must retry`);
    gateway.close();
  }

  const queue = new FetchQueue([
    jsonResponse(errorBody('VALIDATION_ERROR', 'req-400'), 400),
    validStateResponse(),
  ]);
  const gateway = createGateway(queue, { sleep: async () => {} });
  await assert.rejects(
    gateway.reportState(validStateRequest()),
    (error: unknown) => error instanceof BackendHttpError
      && error.disposition === 'fatal'
      && error.requestId === 'req-400',
  );
  assert.equal(queue.requests.length, 1);
  gateway.close();
});

test('gateway maps 401, 403 and 409 to runtime dispositions without retry', async () => {
  const cases = [
    { status: 401, ErrorType: BackendCredentialError, disposition: 'credential' },
    { status: 403, ErrorType: BackendConfigurationError, disposition: 'configuration' },
    { status: 409, ErrorType: BackendConflictError, disposition: 'quarantine' },
  ] as const;

  for (const item of cases) {
    const requestId = `req-${item.status}`;
    const queue = new FetchQueue([
      jsonResponse(errorBody('BACKEND_ERROR', requestId), item.status),
      validStateResponse(),
    ]);
    const gateway = createGateway(queue, { sleep: async () => {} });
    await assert.rejects(
      gateway.reportState(validStateRequest()),
      (error: unknown) => error instanceof item.ErrorType
        && error.disposition === item.disposition
        && error.requestId === requestId,
    );
    assert.equal(queue.requests.length, 1);
    gateway.close();
  }
});

test('gateway rejects successful JSON that violates the backend contract', async () => {
  const queue = new FetchQueue([
    jsonResponse({ device_id: deviceIdValue, status: 'online' }, 200, 'req-invalid'),
  ]);
  const gateway = createGateway(queue);

  await assert.rejects(
    gateway.reportState(validStateRequest()),
    (error: unknown) => error instanceof BackendContractError
      && error.requestId === 'req-invalid',
  );
  assert.equal(queue.requests.length, 1);
  gateway.close();
});

test('gateway aborts a hanging request at the configured timeout', async () => {
  const gateway = new HttpBackendGateway({
    backendUrl: 'https://backend.example.test',
    deviceId,
    deviceToken,
    requestTimeoutMs: 10,
    backoffInitialMs: 1,
    backoffMaxMs: 1,
    maxAttempts: 1,
    fetchImplementation: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('Missing request signal'));
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });

  await assert.rejects(
    gateway.reportState(validStateRequest()),
    (error: unknown) => error instanceof BackendTransportError && error.attempts === 1,
  );
  gateway.close();
});

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
  readonly redirect: RequestRedirect | undefined;
}

type FetchStep = Response | Error;

class FetchQueue {
  readonly requests: CapturedRequest[] = [];
  private readonly steps: FetchStep[];

  constructor(steps: readonly FetchStep[]) {
    this.steps = [...steps];
  }

  readonly fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    this.requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
      redirect: init.redirect,
    });
    const next = this.steps.shift();
    if (!next) throw new Error('Unexpected fetch call');
    if (next instanceof Error) throw next;
    return next;
  };
}

function createGateway(
  queue: FetchQueue,
  overrides: Partial<ConstructorParameters<typeof HttpBackendGateway>[0]> = {},
): HttpBackendGateway {
  return new HttpBackendGateway({
    backendUrl: 'https://backend.example.test',
    deviceId,
    deviceToken,
    requestTimeoutMs: 1_000,
    backoffInitialMs: 10,
    backoffMaxMs: 100,
    maxAttempts: 3,
    fetchImplementation: queue.fetch,
    sleep: async () => {},
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200, requestId?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  if (requestId) headers['x-request-id'] = requestId;
  return new Response(JSON.stringify(body), { status, headers });
}

function errorBody(code: string, requestId: string): unknown {
  return {
    error: {
      code,
      message: 'Safe backend error',
      request_id: requestId,
    },
  };
}

function validStateRequest() {
  return {
    status: 'online' as const,
    reported_at: '2026-11-21T06:00:00.000Z',
    firmware_version: '0.1.0',
    error_code: null,
    error_message: null,
  };
}

function validStateResponse(): Response {
  return jsonResponse({
    device_id: deviceIdValue,
    status: 'online',
    last_seen_at: '2026-11-21T06:00:00.000Z',
    server_time: '2026-11-21T06:00:00.010Z',
  });
}
