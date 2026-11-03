import type { FastifyPluginAsync } from 'fastify';

import type {
  AcknowledgeCommandInput,
  CommandService,
  CreateManualCommandInput,
  ManualFeedingResultInput,
} from '../commands/command.service.js';

interface DeviceParams {
  device_id: string;
}

interface PendingCommandQuery {
  limit?: number;
}

interface CommandParams extends DeviceParams {
  command_id: string;
}

interface FeedingParams extends DeviceParams {
  feeding_id: string;
}

const deviceParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['device_id'],
  properties: {
    device_id: { type: 'string', format: 'uuid' },
  },
} as const;

const commandParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['device_id', 'command_id'],
  properties: {
    device_id: { type: 'string', format: 'uuid' },
    command_id: { type: 'string', format: 'uuid' },
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

const commandBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['command_id', 'portion_grams', 'expires_at'],
  properties: {
    command_id: { type: 'string', format: 'uuid' },
    portion_grams: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 999_999.99,
      multipleOf: 0.01,
    },
    expires_at: { type: 'string', format: 'date-time' },
  },
} as const;

const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;

const commandResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'command_id',
    'feeding_id',
    'device_id',
    'source',
    'portion_grams',
    'status',
    'created_at',
    'expires_at',
    'started_at',
    'finished_at',
    'actual_grams',
    'error_code',
  ],
  properties: {
    command_id: { type: 'string', format: 'uuid' },
    feeding_id: { type: 'string', format: 'uuid' },
    device_id: { type: 'string', format: 'uuid' },
    source: { type: 'string', const: 'manual' },
    portion_grams: { type: 'number' },
    status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'expired'] },
    created_at: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
    started_at: nullableDateTime,
    finished_at: nullableDateTime,
    actual_grams: { type: ['number', 'null'] },
    error_code: { type: ['string', 'null'] },
  },
} as const;

const pendingCommandQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
} as const;

const pendingCommandResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'server_time'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'command_id',
          'feeding_id',
          'device_id',
          'portion_grams',
          'status',
          'created_at',
          'expires_at',
        ],
        properties: {
          command_id: { type: 'string', format: 'uuid' },
          feeding_id: { type: 'string', format: 'uuid' },
          device_id: { type: 'string', format: 'uuid' },
          portion_grams: { type: 'number' },
          status: { type: 'string', const: 'pending' },
          created_at: { type: 'string', format: 'date-time' },
          expires_at: { type: 'string', format: 'date-time' },
        },
      },
    },
    server_time: { type: 'string', format: 'date-time' },
  },
} as const;

const acknowledgeCommandBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['feeding_id', 'status', 'started_at'],
  properties: {
    feeding_id: { type: 'string', format: 'uuid' },
    status: { type: 'string', const: 'running' },
    started_at: { type: 'string', format: 'date-time' },
  },
} as const;

const acknowledgeCommandResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['command_id', 'feeding_id', 'status', 'started_at'],
  properties: {
    command_id: { type: 'string', format: 'uuid' },
    feeding_id: { type: 'string', format: 'uuid' },
    status: { type: 'string', const: 'running' },
    started_at: { type: 'string', format: 'date-time' },
  },
} as const;

const manualResultBaseProperties = {
  command_id: { type: 'string', format: 'uuid' },
  source: { type: 'string', const: 'manual' },
  portion_grams: {
    type: 'number',
    exclusiveMinimum: 0,
    maximum: 999_999.99,
    multipleOf: 0.01,
  },
  started_at: { type: 'string', format: 'date-time' },
  finished_at: { type: 'string', format: 'date-time' },
} as const;

const manualResultRequired = [
  'command_id',
  'source',
  'portion_grams',
  'actual_grams',
  'status',
  'started_at',
  'finished_at',
  'error_code',
  'error_message',
] as const;

const manualResultBodySchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: manualResultRequired,
      properties: {
        ...manualResultBaseProperties,
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
      required: manualResultRequired,
      properties: {
        ...manualResultBaseProperties,
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

const manualResultResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['feeding_id', 'command_id', 'status', 'actual_grams', 'finished_at'],
  properties: {
    feeding_id: { type: 'string', format: 'uuid' },
    command_id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['completed', 'failed'] },
    actual_grams: { type: ['number', 'null'] },
    finished_at: { type: 'string', format: 'date-time' },
  },
} as const;

export function createCommandRoutes(commandService: CommandService): FastifyPluginAsync {
  return async (fastify): Promise<void> => {
    fastify.get<{ Params: DeviceParams; Querystring: PendingCommandQuery }>(
      '/api/v1/devices/:device_id/commands/pending',
      {
        schema: {
          params: deviceParamsSchema,
          querystring: pendingCommandQuerySchema,
          response: { 200: pendingCommandResponseSchema },
        },
      },
      async (request) => commandService.listPending(
        request.params.device_id,
        request.query.limit ?? 10,
      ),
    );

    fastify.post<{ Params: CommandParams; Body: AcknowledgeCommandInput }>(
      '/api/v1/devices/:device_id/commands/:command_id/ack',
      {
        schema: {
          params: commandParamsSchema,
          body: acknowledgeCommandBodySchema,
          response: { 200: acknowledgeCommandResponseSchema },
        },
      },
      async (request) => commandService.acknowledge(
        request.params.device_id,
        request.params.command_id,
        request.body,
      ),
    );

    fastify.post<{ Params: FeedingParams; Body: ManualFeedingResultInput }>(
      '/api/v1/devices/:device_id/feedings/:feeding_id/result',
      {
        schema: {
          params: feedingParamsSchema,
          body: manualResultBodySchema,
          response: { 200: manualResultResponseSchema },
        },
      },
      async (request) => commandService.submitResult(
        request.params.device_id,
        request.params.feeding_id,
        request.body,
      ),
    );

    fastify.post<{ Params: DeviceParams; Body: CreateManualCommandInput }>(
      '/api/v1/devices/:device_id/feeding-commands',
      {
        schema: {
          params: deviceParamsSchema,
          body: commandBodySchema,
          response: {
            200: commandResponseSchema,
            202: commandResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await commandService.create(request.params.device_id, request.body);
        return reply
          .code(result.created ? 202 : 200)
          .send(result.command);
      },
    );
  };
}

