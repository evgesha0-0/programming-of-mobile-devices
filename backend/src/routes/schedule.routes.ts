import type { FastifyPluginAsync } from 'fastify';

import { daysOfWeek } from '../schedules/schedule.types.js';
import type { ScheduleInput, ScheduleService } from '../schedules/schedule.service.js';

interface DeviceParams {
  device_id: string;
}

interface ScheduleParams extends DeviceParams {
  schedule_id: string;
}

interface SyncQuery {
  known_revision: number;
}

const uuidSchema = { type: 'string', format: 'uuid' } as const;

const deviceParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['device_id'],
  properties: { device_id: uuidSchema },
} as const;

const scheduleParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['device_id', 'schedule_id'],
  properties: { device_id: uuidSchema, schedule_id: uuidSchema },
} as const;

const scheduleInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['time_local', 'days_of_week', 'timezone', 'portion_grams', 'active'],
  properties: {
    time_local: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d$' },
    days_of_week: {
      type: 'array',
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
      items: { type: 'string', enum: daysOfWeek },
    },
    timezone: { type: 'string', minLength: 1, maxLength: 64 },
    portion_grams: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 999_999.99,
      multipleOf: 0.01,
    },
    active: { type: 'boolean' },
  },
} as const;

const scheduleItemProperties = {
  schedule_id: uuidSchema,
  time_local: { type: 'string' },
  days_of_week: { type: 'array', items: { type: 'string', enum: daysOfWeek } },
  timezone: { type: 'string' },
  portion_grams: { type: 'number' },
  active: { type: 'boolean' },
  created_at: { type: 'string', format: 'date-time' },
  updated_at: { type: 'string', format: 'date-time' },
} as const;

const scheduleItemRequired = [
  'schedule_id',
  'time_local',
  'days_of_week',
  'timezone',
  'portion_grams',
  'active',
  'created_at',
  'updated_at',
] as const;

const scheduleResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [...scheduleItemRequired, 'device_id', 'schedule_revision'],
  properties: {
    ...scheduleItemProperties,
    device_id: uuidSchema,
    schedule_revision: { type: 'integer', minimum: 0 },
  },
} as const;

const scheduleListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['device_id', 'schedule_revision', 'items'],
  properties: {
    device_id: uuidSchema,
    schedule_revision: { type: 'integer', minimum: 0 },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: scheduleItemRequired,
        properties: scheduleItemProperties,
      },
    },
  },
} as const;

const deleteResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schedule_id', 'deleted', 'schedule_revision', 'deleted_at'],
  properties: {
    schedule_id: uuidSchema,
    deleted: { type: 'boolean', const: true },
    schedule_revision: { type: 'integer', minimum: 0 },
    deleted_at: { type: 'string', format: 'date-time' },
  },
} as const;

const syncQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['known_revision'],
  properties: {
    known_revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

const syncResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['device_id', 'schedule_revision', 'generated_at', 'items'],
  properties: {
    device_id: uuidSchema,
    schedule_revision: { type: 'integer', minimum: 0 },
    generated_at: { type: 'string', format: 'date-time' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'schedule_id',
          'time_local',
          'days_of_week',
          'timezone',
          'portion_grams',
          'active',
          'updated_at',
          'deleted_at',
        ],
        properties: {
          schedule_id: uuidSchema,
          time_local: { type: 'string' },
          days_of_week: { type: 'array', items: { type: 'string', enum: daysOfWeek } },
          timezone: { type: 'string' },
          portion_grams: { type: 'number' },
          active: { type: 'boolean' },
          updated_at: { type: 'string', format: 'date-time' },
          deleted_at: { type: ['string', 'null'], format: 'date-time' },
        },
      },
    },
  },
} as const;

export function createScheduleRoutes(scheduleService: ScheduleService): FastifyPluginAsync {
  return async (fastify): Promise<void> => {
    fastify.get<{ Params: DeviceParams }>(
      '/api/v1/devices/:device_id/schedules',
      { schema: { params: deviceParamsSchema, response: { 200: scheduleListResponseSchema } } },
      async (request) => scheduleService.list(request.params.device_id),
    );

    fastify.get<{ Params: DeviceParams; Querystring: SyncQuery }>(
      '/api/v1/devices/:device_id/sync/schedules',
      {
        schema: {
          params: deviceParamsSchema,
          querystring: syncQuerySchema,
          response: { 200: syncResponseSchema },
        },
      },
      async (request) => scheduleService.sync(
        request.params.device_id,
        request.query.known_revision,
      ),
    );

    fastify.post<{ Params: DeviceParams; Body: ScheduleInput }>(
      '/api/v1/devices/:device_id/schedules',
      { schema: { params: deviceParamsSchema, body: scheduleInputSchema, response: { 201: scheduleResponseSchema } } },
      async (request, reply) => {
        const result = await scheduleService.create(request.params.device_id, request.body);
        return reply.code(201).send(result);
      },
    );

    fastify.put<{ Params: ScheduleParams; Body: ScheduleInput }>(
      '/api/v1/devices/:device_id/schedules/:schedule_id',
      { schema: { params: scheduleParamsSchema, body: scheduleInputSchema, response: { 200: scheduleResponseSchema } } },
      async (request) => scheduleService.update(
        request.params.device_id,
        request.params.schedule_id,
        request.body,
      ),
    );

    fastify.delete<{ Params: ScheduleParams }>(
      '/api/v1/devices/:device_id/schedules/:schedule_id',
      { schema: { params: scheduleParamsSchema, response: { 200: deleteResponseSchema } } },
      async (request) => scheduleService.delete(
        request.params.device_id,
        request.params.schedule_id,
      ),
    );
  };
}

