import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import {
  checkDatabaseConnection,
  closeDatabase,
  createDatabasePool,
} from './db/connection.js';
import { createDeviceRepository } from './devices/device.repository.js';
import { createScheduleRepository } from './schedules/schedule.repository.js';

async function start(): Promise<void> {
  const env = loadEnv();
  const pool = createDatabasePool(env.database);
  const app = await buildApp({
    checkDatabase: () => checkDatabaseConnection(pool),
    deviceRepository: createDeviceRepository(pool),
    scheduleRepository: createScheduleRepository(pool),
    logger: { level: env.logLevel },
  });
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info({ signal }, 'Shutting down server');
    const results = await Promise.allSettled([
      app.close(),
      closeDatabase(pool),
    ]);
    const failure = results.find((result) => result.status === 'rejected');

    if (failure?.status === 'rejected') {
      app.log.error({ err: failure.reason }, 'Graceful shutdown failed');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: env.host, port: env.port });
  } catch (error) {
    app.log.error({ err: error }, 'Failed to start server');
    await app.close();
    await closeDatabase(pool);
    process.exitCode = 1;
  }
}

void start();
