import {
  loadRuntimeConfig,
  runtimeConfigSummary,
  type LoadRuntimeConfigOptions,
  type RuntimeConfig,
} from '../config/index.js';
import type { DeviceId } from '../domain/index.js';
import { createJsonLogger, type JsonLogger } from '../observability/index.js';
import { SqliteLocalStore } from '../adapters/storage-sqlite/index.js';

export interface RuntimeResource {
  close(): void;
}

export interface NetworkBootstrapConfig {
  readonly backendUrl: string;
  readonly deviceId: DeviceId;
  readonly deviceToken: string;
  readonly requestTimeoutMs: number;
}

export interface RuntimeDependencies {
  readonly openStore: (sqlitePath: string) => RuntimeResource;
  readonly openNetwork?: (config: NetworkBootstrapConfig) => RuntimeResource;
}

export interface BootstrapRuntimeOptions extends LoadRuntimeConfigOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly dependencies?: RuntimeDependencies;
  readonly logSink?: (line: string) => void;
  readonly now?: () => Date;
}

export interface RunningRuntime extends RuntimeResource {
  readonly config: RuntimeConfig;
  readonly logger: JsonLogger;
}

const defaultDependencies: RuntimeDependencies = Object.freeze({
  openStore: (sqlitePath: string) => SqliteLocalStore.open({ databasePath: sqlitePath }),
});

export function bootstrapRuntime(options: BootstrapRuntimeOptions = {}): RunningRuntime {
  const config = loadRuntimeConfig(options.environment ?? process.env, {
    cwd: options.cwd,
    readSecretFile: options.readSecretFile,
  });
  const logger = createJsonLogger({
    level: config.logLevel,
    secrets: [config.deviceToken],
    sink: options.logSink,
    now: options.now,
  });
  const dependencies = options.dependencies ?? defaultDependencies;
  const resources: RuntimeResource[] = [];

  logger.info('runtime_configuration_validated', runtimeConfigSummary(config));
  try {
    resources.push(dependencies.openStore(config.sqlitePath));
    if (dependencies.openNetwork) {
      resources.push(dependencies.openNetwork({
        backendUrl: config.backendUrl,
        deviceId: config.deviceId,
        deviceToken: config.deviceToken,
        requestTimeoutMs: config.requestTimeoutMs,
      }));
    }
  } catch (error) {
    let cleanupError: unknown;
    try {
      closeResources(resources);
    } catch (resourceError) {
      cleanupError = resourceError;
    }
    logger.error('runtime_resource_initialization_failed', { error, cleanupError });
    throw error;
  }

  logger.info('runtime_started', runtimeConfigSummary(config));
  let closed = false;
  return Object.freeze({
    config,
    logger,
    close(): void {
      if (closed) return;
      closed = true;
      closeResources(resources);
      logger.info('runtime_stopped');
    },
  });
}

function closeResources(resources: RuntimeResource[]): void {
  let firstError: unknown;
  for (let index = resources.length - 1; index >= 0; index -= 1) {
    const resource = resources[index];
    if (!resource) continue;
    try {
      resource.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}
