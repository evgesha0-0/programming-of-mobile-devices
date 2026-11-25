import { closeDatabase, createDatabasePool } from '../db/connection.js';
import { loadEnv } from '../config/env.js';
import { createUserProvisioningRepository } from './user-provisioning.repository.js';
import { createUserProvisioningService } from './user-provisioning.service.js';

async function main(): Promise<void> {
  let pool: ReturnType<typeof createDatabasePool> | undefined;
  try {
    const deviceId = parseCommand(process.argv.slice(2));
    const env = loadEnv();
    pool = createDatabasePool(env.database);
    const service = createUserProvisioningService(createUserProvisioningRepository(pool));
    const result = await service.provisionOwner(deviceId);
    process.stdout.write(`${JSON.stringify({
      user_id: result.userId,
      user_token: result.userToken,
      device_id: result.deviceId,
      role: result.role,
    }, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown user provisioning error';
    process.stderr.write(`User provisioning failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    if (pool) await closeDatabase(pool);
  }
}

function parseCommand(args: string[]): string {
  const [operation, option, value] = args;
  if (operation !== 'provision-owner' || option !== '--device-id' || !value || args.length !== 3) {
    throw new Error('Expected provision-owner --device-id <uuid>');
  }
  return value;
}

void main();
