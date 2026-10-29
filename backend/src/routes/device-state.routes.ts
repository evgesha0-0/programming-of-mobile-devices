import type { FastifyPluginAsync } from 'fastify';

import { reportedDeviceStatuses } from '../devices/device.types.js';
import type {
  DeviceService,
  ReportDeviceStateInput,
} from '../devices/device.service.js';

interface DeviceParams {
  device_id: string;
}

const deviceParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['device_id'],
  properties: {
    device_id: { type: 'string', format: 'uuid' },
  },
} as const;

const lastErrorSchema = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: ['string', 'null'] },
        message: { type: ['string', 'null'] },
      },
    },
  ],
} as const;

const deviceStateResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['device_id', 'status', 'last_seen_at', 'last_error', 'schedule_revision'],
  properties: {
    device_id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['online', 'busy', 'error', 'offline', 'unknown'] },
    last_seen_at: { type: ['string', 'null'], format: 'date-time' },
    last_error: lastErrorSchema,
    schedule_revision: { type: 'integer', minimum: 0 },
  },
} as const;

const reportStateBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reported_at', 'firmware_version', 'error_code', 'error_message'],
  properties: {
    status: { type: 'string', enum: reportedDeviceStatuses },
    reported_at: { type: 'string', format: 'date-time' },
    firmware_version: { type: 'string', minLength: 1, maxLength: 64 },
    error_code: { type: ['string', 'null'], maxLength: 64 },
    error_message: { type: ['string', 'null'], maxLength: 2_000 },
  },
} as const;

const reportStateResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['device_id', 'status', 'last_seen_at', 'server_time'],
  properties: {
    device_id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['online', 'busy', 'error', 'unknown'] },
    last_seen_at: { type: 'string', format: 'date-time' },
    server_time: { type: 'string', format: 'date-time' },
  },
} as const;

export function createDeviceStateRoutes(deviceService: DeviceService): FastifyPluginAsync {
  return async (fastify): Promise<void> => {
    fastify.get<{ Params: DeviceParams }>(
      '/api/v1/devices/:device_id/state',
      {
        schema: {
          params: deviceParamsSchema,
          response: { 200: deviceStateResponseSchema },
        },
      },
      async (request) => deviceService.getState(request.params.device_id),
    );

    fastify.put<{ Params: DeviceParams; Body: ReportDeviceStateInput }>(
      '/api/v1/devices/:device_id/state',
      {
        schema: {
          params: deviceParamsSchema,
          body: reportStateBodySchema,
          response: { 200: reportStateResponseSchema },
        },
      },
      async (request) => deviceService.reportState(request.params.device_id, request.body),
    );
  };
}

