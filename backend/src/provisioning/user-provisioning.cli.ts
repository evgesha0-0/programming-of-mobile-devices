import { closeDatabase, createDatabasePool } from '../db/connection.js';
import { loadEnv } from '../config/env.js';
import { createUserProvisioningRepository } from './user-provisioning.repository.js';
import { createUserProvisioningService } from './user-provisioning.service.js';

type UserProvisioningCommand =
  | { kind: 'provision-owner'; deviceId: string }
  | { kind: 'rotate'; userId: string }
  | { kind: 'revoke'; userId: string };

async function main(): Promise<void> {
  let pool: ReturnType<typeof createDatabasePool> | undefined;
  try {
    const command = parseCommand(process.argv.slice(2));
    const env = loadEnv();
    pool = createDatabasePool(env.database);
    const service = createUserProvisioningService(createUserProvisioningRepository(pool));

    if (command.kind === 'provision-owner') {
      const result = await service.provisionOwner(command.deviceId);
      process.stdout.write(`${JSON.stringify({
        user_id: result.userId,
        user_token: result.userToken,
        device_id: result.deviceId,
        role: result.role,
      }, null, 2)}\n`);
    } else if (command.kind === 'rotate') {
      const result = await service.rotateUserToken(command.userId);
      process.stdout.write(`${JSON.stringify({
        user_id: result.userId,
        user_token: result.userToken,
      }, null, 2)}\n`);
    } else {
      const result = await service.revokeUserToken(command.userId);
      process.stdout.write(`${JSON.stringify({
        user_id: result.userId,
        revoked: result.revoked,
      }, null, 2)}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown user provisioning error';
    process.stderr.write(`User provisioning failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    if (pool) await closeDatabase(pool);
  }
}

function parseCommand(args: string[]): UserProvisioningCommand {
  const [operation, ...options] = args;
  if (operation === 'provision-owner') {
    return { kind: operation, deviceId: readSingleOption(options, '--device-id') };
  }
  if (operation === 'rotate' || operation === 'revoke') {
    return { kind: operation, userId: readSingleOption(options, '--user-id') };
  }
  throw new Error('Expected provision-owner, rotate, or revoke command');
}

function readSingleOption(args: string[], option: string): string {
  const value = args[1];
  if (args.length !== 2 || args[0] !== option || !value) {
    throw new Error(`Expected ${option} <value>`);
  }
  return value;
}

void main();
