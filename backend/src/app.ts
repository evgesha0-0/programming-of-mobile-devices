import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import type { DatabaseCheck } from './db/connection.js';
import { createDeviceService } from './devices/device.service.js';
import type { DeviceRepository } from './devices/device.repository.js';
import { createDeviceStateRoutes } from './routes/device-state.routes.js';
import { createHealthRoutes } from './routes/health.routes.js';
import { errorHandler } from './utils/error-handler.js';

export interface BuildAppOptions {
  checkDatabase: DatabaseCheck;
  deviceRepository: DeviceRepository;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  });

  app.setErrorHandler(errorHandler);
  await app.register(createHealthRoutes(options.checkDatabase));
  await app.register(createDeviceStateRoutes(createDeviceService(options.deviceRepository)));

  return app;
}
