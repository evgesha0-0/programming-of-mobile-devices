import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import type { DatabaseCheck } from './db/connection.js';
import { createDeviceService } from './devices/device.service.js';
import type { DeviceRepository } from './devices/device.repository.js';
import { createDeviceStateRoutes } from './routes/device-state.routes.js';
import { createHealthRoutes } from './routes/health.routes.js';
import { createScheduleRoutes } from './routes/schedule.routes.js';
import type { ScheduleRepository } from './schedules/schedule.repository.js';
import { createScheduleService } from './schedules/schedule.service.js';
import { errorHandler } from './utils/error-handler.js';

export interface BuildAppOptions {
  checkDatabase: DatabaseCheck;
  deviceRepository: DeviceRepository;
  scheduleRepository: ScheduleRepository;
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
  await app.register(createScheduleRoutes(createScheduleService(options.scheduleRepository)));

  return app;
}
