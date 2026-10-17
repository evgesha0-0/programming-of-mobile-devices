import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import type { DatabaseCheck } from './db/connection.js';
import { createHealthRoutes } from './routes/health.routes.js';
import { errorHandler } from './utils/error-handler.js';

export interface BuildAppOptions {
  checkDatabase: DatabaseCheck;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
  });

  app.setErrorHandler(errorHandler);
  await app.register(createHealthRoutes(options.checkDatabase));

  return app;
}
