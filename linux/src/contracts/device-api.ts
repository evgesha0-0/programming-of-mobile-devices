import { z } from 'zod';

import {
  actualGramsSchema,
  commandIdSchema,
  daysOfWeekSchema,
  deviceIdSchema,
  errorCodeSchema,
  errorMessageSchema,
  feedingIdSchema,
  localTimeSchema,
  portionGramsSchema,
  reportedDeviceStatusSchema,
  scheduleIdSchema,
  timezoneSchema,
  utcDateTimeSchema,
  type CommandId,
  type DeviceId,
  type FeedingId,
} from '../domain/index.js';

export const reportDeviceStateRequestSchema = z.object({
  status: reportedDeviceStatusSchema,
  reported_at: utcDateTimeSchema,
  firmware_version: z.string().min(1).max(64),
  error_code: errorCodeSchema.nullable(),
  error_message: errorMessageSchema.nullable(),
}).strict();

export const reportDeviceStateResponseSchema = z.object({
  device_id: deviceIdSchema,
  status: reportedDeviceStatusSchema,
  last_seen_at: utcDateTimeSchema,
  server_time: utcDateTimeSchema,
}).strict();

export const scheduleSnapshotItemSchema = z.object({
  schedule_id: scheduleIdSchema,
  time_local: localTimeSchema,
  days_of_week: daysOfWeekSchema,
  timezone: timezoneSchema,
  portion_grams: portionGramsSchema,
  active: z.boolean(),
  updated_at: utcDateTimeSchema,
  deleted_at: utcDateTimeSchema.nullable(),
}).strict();

export const scheduleSyncResponseSchema = z.object({
  device_id: deviceIdSchema,
  schedule_revision: z.number().int().nonnegative().safe(),
  generated_at: utcDateTimeSchema,
  items: z.array(scheduleSnapshotItemSchema),
}).strict();

const pendingCommandSchema = z.object({
  command_id: commandIdSchema,
  feeding_id: feedingIdSchema,
  device_id: deviceIdSchema,
  portion_grams: portionGramsSchema,
  status: z.literal('pending'),
  created_at: utcDateTimeSchema,
  expires_at: utcDateTimeSchema,
}).strict().superRefine((command, context) => {
  if (Date.parse(command.expires_at) <= Date.parse(command.created_at)) {
    context.addIssue({
      code: 'custom',
      path: ['expires_at'],
      message: 'Command expiration must be later than creation time',
    });
  }
});

export const pendingCommandsResponseSchema = z.object({
  items: z.array(pendingCommandSchema),
  server_time: utcDateTimeSchema,
}).strict();

export const acknowledgeCommandRequestSchema = z.object({
  feeding_id: feedingIdSchema,
  status: z.literal('running'),
  started_at: utcDateTimeSchema,
}).strict();

export const acknowledgeCommandResponseSchema = z.object({
  command_id: commandIdSchema,
  feeding_id: feedingIdSchema,
  status: z.literal('running'),
  started_at: utcDateTimeSchema,
}).strict();

const completedManualResultSchema = z.object({
  command_id: commandIdSchema,
  source: z.literal('manual'),
  portion_grams: portionGramsSchema,
  actual_grams: actualGramsSchema,
  status: z.literal('completed'),
  started_at: utcDateTimeSchema,
  finished_at: utcDateTimeSchema,
  error_code: z.null(),
  error_message: z.null(),
}).strict();

const failedManualResultSchema = z.object({
  command_id: commandIdSchema,
  source: z.literal('manual'),
  portion_grams: portionGramsSchema,
  actual_grams: actualGramsSchema.nullable(),
  status: z.literal('failed'),
  started_at: utcDateTimeSchema,
  finished_at: utcDateTimeSchema,
  error_code: errorCodeSchema,
  error_message: errorMessageSchema,
}).strict();

export const manualFeedingResultRequestSchema = z.discriminatedUnion('status', [
  completedManualResultSchema,
  failedManualResultSchema,
]).superRefine(validateFinishedAfterStarted);

const completedManualResultResponseSchema = z.object({
  feeding_id: feedingIdSchema,
  command_id: commandIdSchema,
  status: z.literal('completed'),
  actual_grams: actualGramsSchema,
  finished_at: utcDateTimeSchema,
}).strict();

const failedManualResultResponseSchema = z.object({
  feeding_id: feedingIdSchema,
  command_id: commandIdSchema,
  status: z.literal('failed'),
  actual_grams: actualGramsSchema.nullable(),
  finished_at: utcDateTimeSchema,
}).strict();

export const manualFeedingResultResponseSchema = z.discriminatedUnion('status', [
  completedManualResultResponseSchema,
  failedManualResultResponseSchema,
]);

const scheduledEventBase = {
  feeding_id: feedingIdSchema,
  schedule_id: scheduleIdSchema,
  source: z.literal('scheduled'),
  portion_grams: portionGramsSchema,
  created_at: utcDateTimeSchema,
  started_at: utcDateTimeSchema,
  finished_at: utcDateTimeSchema,
};

const completedScheduledEventSchema = z.object({
  ...scheduledEventBase,
  actual_grams: actualGramsSchema,
  status: z.literal('completed'),
  error_code: z.null(),
  error_message: z.null(),
}).strict();

const failedScheduledEventSchema = z.object({
  ...scheduledEventBase,
  actual_grams: actualGramsSchema.nullable(),
  status: z.literal('failed'),
  error_code: errorCodeSchema,
  error_message: errorMessageSchema,
}).strict();

export const scheduledFeedingEventRequestSchema = z.discriminatedUnion('status', [
  completedScheduledEventSchema,
  failedScheduledEventSchema,
]).superRefine((event, context) => {
  validateFinishedAfterStarted(event, context);
  if (Date.parse(event.started_at) < Date.parse(event.created_at)) {
    context.addIssue({
      code: 'custom',
      path: ['started_at'],
      message: 'Feeding start time must not be earlier than creation time',
    });
  }
});

const completedScheduledEventResponseSchema = z.object({
  feeding_id: feedingIdSchema,
  device_id: deviceIdSchema,
  schedule_id: scheduleIdSchema,
  source: z.literal('scheduled'),
  status: z.literal('completed'),
  actual_grams: actualGramsSchema,
  received_at: utcDateTimeSchema,
}).strict();

const failedScheduledEventResponseSchema = z.object({
  feeding_id: feedingIdSchema,
  device_id: deviceIdSchema,
  schedule_id: scheduleIdSchema,
  source: z.literal('scheduled'),
  status: z.literal('failed'),
  actual_grams: actualGramsSchema.nullable(),
  received_at: utcDateTimeSchema,
}).strict();

export const scheduledFeedingEventResponseSchema = z.discriminatedUnion('status', [
  completedScheduledEventResponseSchema,
  failedScheduledEventResponseSchema,
]);

const apiErrorDetailSchema = z.object({
  field: z.string().min(1),
  reason: z.string().min(1),
}).strict();

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.array(apiErrorDetailSchema).optional(),
    request_id: z.string().min(1),
  }).strict(),
}).strict();

export const deviceApiPaths = Object.freeze({
  state(deviceId: DeviceId): string {
    return `/api/v1/devices/${deviceId}/state`;
  },
  schedules(deviceId: DeviceId, knownRevision: number): string {
    assertNonnegativeSafeInteger(knownRevision, 'knownRevision');
    return `/api/v1/devices/${deviceId}/sync/schedules?known_revision=${knownRevision}`;
  },
  pendingCommands(deviceId: DeviceId, limit = 10): string {
    assertPositiveSafeInteger(limit, 'limit');
    return `/api/v1/devices/${deviceId}/commands/pending?limit=${limit}`;
  },
  acknowledgeCommand(deviceId: DeviceId, commandId: CommandId): string {
    return `/api/v1/devices/${deviceId}/commands/${commandId}/ack`;
  },
  feedingResult(deviceId: DeviceId, feedingId: FeedingId): string {
    return `/api/v1/devices/${deviceId}/feedings/${feedingId}/result`;
  },
  feedingEvents(deviceId: DeviceId): string {
    return `/api/v1/devices/${deviceId}/feeding-events`;
  },
});

export type ReportDeviceStateRequest = z.infer<typeof reportDeviceStateRequestSchema>;
export type ReportDeviceStateResponse = z.infer<typeof reportDeviceStateResponseSchema>;
export type ScheduleSyncResponse = z.infer<typeof scheduleSyncResponseSchema>;
export type PendingCommandsResponse = z.infer<typeof pendingCommandsResponseSchema>;
export type AcknowledgeCommandRequest = z.infer<typeof acknowledgeCommandRequestSchema>;
export type AcknowledgeCommandResponse = z.infer<typeof acknowledgeCommandResponseSchema>;
export type ManualFeedingResultRequest = z.infer<typeof manualFeedingResultRequestSchema>;
export type ManualFeedingResultResponse = z.infer<typeof manualFeedingResultResponseSchema>;
export type ScheduledFeedingEventRequest = z.infer<typeof scheduledFeedingEventRequestSchema>;
export type ScheduledFeedingEventResponse = z.infer<typeof scheduledFeedingEventResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

function validateFinishedAfterStarted(
  value: { started_at: string; finished_at: string },
  context: z.RefinementCtx,
): void {
  if (Date.parse(value.finished_at) < Date.parse(value.started_at)) {
    context.addIssue({
      code: 'custom',
      path: ['finished_at'],
      message: 'Feeding finish time must not be earlier than start time',
    });
  }
}

function assertNonnegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative safe integer`);
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
