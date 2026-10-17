import type { FastifyPluginAsync } from 'fastify';

import type { DatabaseCheck } from '../db/connection.js';

const healthResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'service'],
  properties: {
    status: { type: 'string', const: 'ok' },
    service: { type: 'string', const: 'smart-cat-feeder-backend' },
  },
} as const;

const readinessResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'database'],
  properties: {
    status: { type: 'string', enum: ['ready', 'not_ready'] },
    database: { type: 'string', enum: ['connected', 'disconnected'] },
  },
} as const;

export function createHealthRoutes(checkDatabase: DatabaseCheck): FastifyPluginAsync {
  return async (fastify): Promise<void> => {
    fastify.get(
      '/health',
      {
        schema: {
          summary: 'Проверить работу HTTP-сервера',
          response: { 200: healthResponseSchema },
        },
      },
      async () => ({
        status: 'ok' as const,
        service: 'smart-cat-feeder-backend' as const,
      }),
    );

    fastify.get(
      '/ready',
      {
        schema: {
          summary: 'Проверить готовность PostgreSQL',
          response: {
            200: readinessResponseSchema,
            503: readinessResponseSchema,
          },
        },
      },
      async (_request, reply) => {
        try {
          await checkDatabase();
          return reply.code(200).send({
            status: 'ready' as const,
            database: 'connected' as const,
          });
        } catch (error) {
          fastify.log.warn({ err: error }, 'PostgreSQL readiness check failed');
          return reply.code(503).send({
            status: 'not_ready' as const,
            database: 'disconnected' as const,
          });
        }
      },
    );
  };
}
