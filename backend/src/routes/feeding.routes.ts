import type { FastifyPluginAsync } from 'fastify';

import type {
  FeedingService,
  ScheduledFeedingInput,
} from '../feedings/feeding.service.js';

interface DeviceParams {
  device_id: string;
}

interface FeedingParams extends DeviceParams {
  feeding_id: string;
}

interface FeedingHistoryQuery {
  limit?: number;
  cursor?: string;
}

const deviceParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['device_id'],
  properties: {
    device_id: { type: 'string', format: 'uuid' },
  },
} as const;

const feedingParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['device_id', 'feeding_id'],
  properties: {
    device_id: { type: 'string', format: 'uuid' },
    feeding_id: { type: 'string', format: 'uuid' },
  },
} as const;

const historyQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
  },
} as const;

const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;

const historyItemRequired = [
  'feeding_id',
  'device_id',
  'schedule_id',
  'command_id',
  'source',
  'portion_grams',
  'actual_grams',
  'status',
  'created_at',
  'started_at',
  'finished_at',
  'error_code',
] as const;

const historyItemProperties = {
  feeding_id: { type: 'string', format: 'uuid' },
  device_id: { type: 'string', format: 'uuid' },
  schedule_id: { type: ['string', 'null'], format: 'uuid' },
  command_id: { type: ['string', 'null'], format: 'uuid' },
  source: { type: 'string', enum: ['manual', 'scheduled'] },
  portion_grams: { type: 'number' },
  actual_grams: { type: ['number', 'null'] },
  status: {
    type: 'string',
    enum: ['pending', 'running', 'completed', 'failed', 'expired'],
  },
  created_at: { type: 'string', format: 'date-time' },
  started_at: nullableDateTime,
  finished_at: nullableDateTime,
  error_code: { type: ['string', 'null'] },
} as const;

const historyResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'next_cursor'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: historyItemRequired,
        properties: historyItemProperties,
      },
    },
    next_cursor: { type: ['string', 'null'] },
  },
} as const;

const feedingDetailsResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [...historyItemRequired, 'error_message'],
  properties: {
    ...historyItemProperties,
    error_message: { type: ['string', 'null'] },
  },
} as const;

const eventBaseProperties = {
  feeding_id: { type: 'string', format: 'uuid' },
  schedule_id: { type: 'string', format: 'uuid' },
  source: { type: 'string', const: 'scheduled' },
  portion_grams: {
    type: 'number',
    exclusiveMinimum: 0,
    maximum: 999_999.99,
    multipleOf: 0.01,
  },
  created_at: { type: 'string', format: 'date-time' },
  started_at: { type: 'string', format: 'date-time' },
  finished_at: { type: 'string', format: 'date-time' },
} as const;

const eventRequired = [
  'feeding_id',
  'schedule_id',
  'source',
  'portion_grams',
  'actual_grams',
  'status',
  'created_at',
  'started_at',
  'finished_at',
  'error_code',
  'error_message',
] as const;

const eventBodySchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: eventRequired,
      properties: {
        ...eventBaseProperties,
        actual_grams: {
          type: 'number',
          minimum: 0,
          maximum: 999_999.99,
          multipleOf: 0.01,
        },
        status: { type: 'string', const: 'completed' },
        error_code: { type: 'null' },
        error_message: { type: 'null' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: eventRequired,
      properties: {
        ...eventBaseProperties,
        actual_grams: {
          type: ['number', 'null'],
          minimum: 0,
          maximum: 999_999.99,
          multipleOf: 0.01,
        },
        status: { type: 'string', const: 'failed' },
        error_code: { type: 'string', minLength: 1, maxLength: 64, pattern: '\\S' },
        error_message: { type: 'string', minLength: 1, maxLength: 2_000, pattern: '\\S' },
      },
    },
  ],
} as const;

const eventResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'feeding_id',
    'device_id',
    'schedule_id',
    'source',
    'status',
    'actual_grams',
    'received_at',
  ],
  properties: {
    feeding_id: { type: 'string', format: 'uuid' },
    device_id: { type: 'string', format: 'uuid' },
    schedule_id: { type: 'string', format: 'uuid' },
    source: { type: 'string', const: 'scheduled' },
    status: { type: 'string', enum: ['completed', 'failed'] },
    actual_grams: { type: ['number', 'null'] },
    received_at: { type: 'string', format: 'date-time' },
  },
} as const;

export function createFeedingRoutes(feedingService: FeedingService): FastifyPluginAsync {
  return async (fastify): Promise<void> => {
    fastify.get<{ Params: DeviceParams; Querystring: FeedingHistoryQuery }>(
      '/api/v1/devices/:device_id/feedings',
      {
        schema: {
          params: deviceParamsSchema,
          querystring: historyQuerySchema,
          response: { 200: historyResponseSchema },
        },
      },
      async (request) => feedingService.listHistory(
        request.params.device_id,
        request.query.limit ?? 50,
        request.query.cursor,
      ),
    );

    fastify.get<{ Params: FeedingParams }>(
      '/api/v1/devices/:device_id/feedings/:feeding_id',
      {
        schema: {
          params: feedingParamsSchema,
          response: { 200: feedingDetailsResponseSchema },
        },
      },
      async (request) => feedingService.getDetails(
        request.params.device_id,
        request.params.feeding_id,
      ),
    );

    fastify.post<{ Params: DeviceParams; Body: ScheduledFeedingInput }>(
      '/api/v1/devices/:device_id/feeding-events',
      {
        schema: {
          params: deviceParamsSchema,
          body: eventBodySchema,
          response: {
            200: eventResponseSchema,
            201: eventResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await feedingService.createScheduledEvent(
          request.params.device_id,
          request.body,
        );
        return reply
          .code(result.created ? 201 : 200)
          .send(result.event);
      },
    );
  };
}
