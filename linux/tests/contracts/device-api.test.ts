import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acknowledgeCommandRequestSchema,
  acknowledgeCommandResponseSchema,
  apiErrorResponseSchema,
  deviceApiPaths,
  manualFeedingResultRequestSchema,
  manualFeedingResultResponseSchema,
  pendingCommandsResponseSchema,
  reportDeviceStateRequestSchema,
  reportDeviceStateResponseSchema,
  scheduledFeedingEventRequestSchema,
  scheduledFeedingEventResponseSchema,
  scheduleSyncResponseSchema,
} from '../../src/contracts/index.js';
import {
  commandIdSchema,
  deviceIdSchema,
  feedingIdSchema,
} from '../../src/domain/index.js';

const deviceIdValue = 'd6d174f4-e79f-49d1-9476-78bc99483752';
const scheduleIdValue = '811f98b6-e0f9-40ad-9b5e-46d501f1a1d3';
const commandIdValue = 'a891f5dd-645c-4a98-b3b4-a8c3fd6f9dd7';
const feedingIdValue = 'a552a367-1de4-4381-a238-d93f1f1da654';

test('device API paths match the documented versioned endpoints', () => {
  const deviceId = deviceIdSchema.parse(deviceIdValue);
  const commandId = commandIdSchema.parse(commandIdValue);
  const feedingId = feedingIdSchema.parse(feedingIdValue);

  assert.equal(deviceApiPaths.state(deviceId), `/api/v1/devices/${deviceIdValue}/state`);
  assert.equal(
    deviceApiPaths.schedules(deviceId, 12),
    `/api/v1/devices/${deviceIdValue}/sync/schedules?known_revision=12`,
  );
  assert.equal(
    deviceApiPaths.pendingCommands(deviceId),
    `/api/v1/devices/${deviceIdValue}/commands/pending?limit=10`,
  );
  assert.equal(
    deviceApiPaths.acknowledgeCommand(deviceId, commandId),
    `/api/v1/devices/${deviceIdValue}/commands/${commandIdValue}/ack`,
  );
  assert.equal(
    deviceApiPaths.feedingResult(deviceId, feedingId),
    `/api/v1/devices/${deviceIdValue}/feedings/${feedingIdValue}/result`,
  );
  assert.equal(
    deviceApiPaths.feedingEvents(deviceId),
    `/api/v1/devices/${deviceIdValue}/feeding-events`,
  );
  assert.throws(() => deviceApiPaths.schedules(deviceId, -1), RangeError);
  assert.throws(() => deviceApiPaths.pendingCommands(deviceId, 0), RangeError);
});

test('state contracts accept a strict heartbeat and reject offline reports', () => {
  const request = {
    status: 'online',
    reported_at: '2026-10-29T08:15:30Z',
    firmware_version: '0.1.0',
    error_code: null,
    error_message: null,
  };
  const response = {
    device_id: deviceIdValue,
    status: 'online',
    last_seen_at: '2026-10-29T08:15:30Z',
    server_time: '2026-10-29T08:15:31Z',
  };

  assert.equal(reportDeviceStateRequestSchema.safeParse(request).success, true);
  assert.equal(reportDeviceStateResponseSchema.safeParse(response).success, true);
  assert.equal(reportDeviceStateRequestSchema.safeParse({ ...request, status: 'offline' }).success, false);
  assert.equal(reportDeviceStateRequestSchema.safeParse({ ...request, secret: 'unexpected' }).success, false);
});

test('schedule sync contract validates the complete snapshot', () => {
  const snapshot = {
    device_id: deviceIdValue,
    schedule_revision: 13,
    generated_at: '2026-10-29T08:20:00Z',
    items: [{
      schedule_id: scheduleIdValue,
      time_local: '08:30:00',
      days_of_week: ['mon', 'wed', 'fri'],
      timezone: 'Asia/Vladivostok',
      portion_grams: 45.5,
      active: true,
      updated_at: '2026-10-29T08:19:00Z',
      deleted_at: null,
    }],
  };

  assert.equal(scheduleSyncResponseSchema.safeParse(snapshot).success, true);
  assert.equal(scheduleSyncResponseSchema.safeParse({
    ...snapshot,
    items: [{ ...snapshot.items[0], days_of_week: ['mon', 'mon'] }],
  }).success, false);
  assert.equal(scheduleSyncResponseSchema.safeParse({
    ...snapshot,
    items: [{ ...snapshot.items[0], timezone: 'Not/A-Timezone' }],
  }).success, false);
});

test('pending command and acknowledgement contracts enforce their lifecycle phase', () => {
  const commandResponse = {
    items: [{
      command_id: commandIdValue,
      feeding_id: feedingIdValue,
      device_id: deviceIdValue,
      portion_grams: 40,
      status: 'pending',
      created_at: '2026-10-29T08:20:00Z',
      expires_at: '2026-10-29T08:25:00Z',
    }],
    server_time: '2026-10-29T08:20:01Z',
  };
  const acknowledgementRequest = {
    feeding_id: feedingIdValue,
    status: 'running',
    started_at: '2026-10-29T08:21:00Z',
  };
  const acknowledgementResponse = {
    command_id: commandIdValue,
    ...acknowledgementRequest,
  };

  assert.equal(pendingCommandsResponseSchema.safeParse(commandResponse).success, true);
  assert.equal(acknowledgeCommandRequestSchema.safeParse(acknowledgementRequest).success, true);
  assert.equal(acknowledgeCommandResponseSchema.safeParse(acknowledgementResponse).success, true);
  assert.equal(pendingCommandsResponseSchema.safeParse({
    ...commandResponse,
    items: [{
      ...commandResponse.items[0],
      expires_at: commandResponse.items[0]?.created_at,
    }],
  }).success, false);
  assert.equal(acknowledgeCommandRequestSchema.safeParse({
    ...acknowledgementRequest,
    status: 'completed',
  }).success, false);
});

test('manual result contracts keep completed and failed payloads consistent', () => {
  const completed = {
    command_id: commandIdValue,
    source: 'manual',
    portion_grams: 40,
    actual_grams: 39.5,
    status: 'completed',
    started_at: '2026-10-29T08:21:00Z',
    finished_at: '2026-10-29T08:21:10Z',
    error_code: null,
    error_message: null,
  };
  const failed = {
    ...completed,
    actual_grams: null,
    status: 'failed',
    error_code: 'MOTOR_ERROR',
    error_message: 'Motor is blocked',
  };

  assert.equal(manualFeedingResultRequestSchema.safeParse(completed).success, true);
  assert.equal(manualFeedingResultRequestSchema.safeParse(failed).success, true);
  assert.equal(manualFeedingResultRequestSchema.safeParse({ ...completed, actual_grams: null }).success, false);
  assert.equal(manualFeedingResultRequestSchema.safeParse({ ...failed, error_code: null }).success, false);
  assert.equal(manualFeedingResultRequestSchema.safeParse({
    ...completed,
    finished_at: '2026-10-29T08:20:59Z',
  }).success, false);
  assert.equal(manualFeedingResultResponseSchema.safeParse({
    feeding_id: feedingIdValue,
    command_id: commandIdValue,
    status: 'completed',
    actual_grams: 39.5,
    finished_at: '2026-10-29T08:21:10Z',
  }).success, true);
});

test('scheduled event contracts validate source, chronology and result shape', () => {
  const event = {
    feeding_id: feedingIdValue,
    schedule_id: scheduleIdValue,
    source: 'scheduled',
    portion_grams: 45.5,
    actual_grams: 45.25,
    status: 'completed',
    created_at: '2026-10-29T08:29:59Z',
    started_at: '2026-10-29T08:30:00Z',
    finished_at: '2026-10-29T08:30:08Z',
    error_code: null,
    error_message: null,
  };

  assert.equal(scheduledFeedingEventRequestSchema.safeParse(event).success, true);
  assert.equal(scheduledFeedingEventRequestSchema.safeParse({ ...event, source: 'manual' }).success, false);
  assert.equal(scheduledFeedingEventRequestSchema.safeParse({
    ...event,
    started_at: '2026-10-29T08:29:58Z',
  }).success, false);
  assert.equal(scheduledFeedingEventResponseSchema.safeParse({
    feeding_id: feedingIdValue,
    device_id: deviceIdValue,
    schedule_id: scheduleIdValue,
    source: 'scheduled',
    status: 'completed',
    actual_grams: 45.25,
    received_at: '2026-10-29T08:30:09Z',
  }).success, true);
});

test('error contract accepts documented details and current backend responses', () => {
  const currentBackendError = {
    error: {
      code: 'NOT_FOUND',
      message: 'Device not found',
      request_id: 'req-42',
    },
  };
  const documentedError = {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: [{ field: 'portion_grams', reason: 'Must be positive' }],
      request_id: 'req-43',
    },
  };

  assert.equal(apiErrorResponseSchema.safeParse(currentBackendError).success, true);
  assert.equal(apiErrorResponseSchema.safeParse(documentedError).success, true);
  assert.equal(apiErrorResponseSchema.safeParse({
    ...currentBackendError,
    debug: 'must not be exposed',
  }).success, false);
});
