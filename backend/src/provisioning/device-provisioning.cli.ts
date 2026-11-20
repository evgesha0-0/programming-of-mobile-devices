import { closeDatabase, createDatabasePool } from '../db/connection.js';
import { loadEnv } from '../config/env.js';
import { createDeviceProvisioningRepository } from './device-provisioning.repository.js';
import { createDeviceProvisioningService } from './device-provisioning.service.js';

type ProvisioningCommand =
  | { kind: 'provision'; name: string }
  | { kind: 'rotate'; deviceId: string }
  | { kind: 'revoke'; deviceId: string };

async function main(): Promise<void> {
  let pool: ReturnType<typeof createDatabasePool> | undefined;
  try {
    const command = parseCommand(process.argv.slice(2));
    const env = loadEnv();
    pool = createDatabasePool(env.database);
    const service = createDeviceProvisioningService(createDeviceProvisioningRepository(pool));

    if (command.kind === 'provision') {
      writeIssuedCredential(await service.provisionDevice(command.name));
    } else if (command.kind === 'rotate') {
      writeIssuedCredential(await service.rotateDeviceToken(command.deviceId));
    } else {
      const result = await service.revokeDeviceToken(command.deviceId);
      process.stdout.write(`${JSON.stringify({
        device_id: result.deviceId,
        revoked: result.revoked,
      }, null, 2)}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown provisioning error';
    process.stderr.write(`Provisioning failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    if (pool) await closeDatabase(pool);
  }
}

function parseCommand(args: string[]): ProvisioningCommand {
  const [operation, ...options] = args;
  if (operation === 'provision') {
    return { kind: 'provision', name: readSingleOption(options, '--name') };
  }
  if (operation === 'rotate' || operation === 'revoke') {
    return { kind: operation, deviceId: readSingleOption(options, '--device-id') };
  }
  throw new Error('Expected provision, rotate, or revoke command');
}

function readSingleOption(args: string[], option: string): string {
  const value = args[1];
  if (args.length !== 2 || args[0] !== option || !value) {
    throw new Error(`Expected ${option} <value>`);
  }
  return value;
}

function writeIssuedCredential(result: { deviceId: string; deviceToken: string }): void {
  process.stdout.write(`${JSON.stringify({
    device_id: result.deviceId,
    device_token: result.deviceToken,
  }, null, 2)}\n`);
}

void main();
