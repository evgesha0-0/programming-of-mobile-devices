import {
  loadRuntimeConfig,
  runtimeConfigSummary,
  type LoadRuntimeConfigOptions,
  type RuntimeConfig,
} from '../config/index.js';
import {
  CommandPoller,
  DeviceStateReporter,
  FeedingOrchestrator,
  LocalScheduler,
  ManualCommandQueue,
  ScheduleSyncService,
} from '../application/index.js';
import { serviceMetadata } from '../app.js';
import type { DeviceId } from '../domain/index.js';
import { createJsonLogger, LoggerTelemetry, type JsonLogger } from '../observability/index.js';
import { HttpBackendGateway } from '../adapters/backend-http/index.js';
import { SqliteLocalStore } from '../adapters/storage-sqlite/index.js';
import { SystemClock } from '../adapters/system-clock/index.js';
import type { BackendGateway, LocalStore } from '../ports/index.js';
import {
  createDigitalTwin,
  SimulatorControlServer,
} from '../simulator/index.js';

export interface RuntimeResource {
  close(): void;
}

export interface NetworkBootstrapConfig {
  readonly backendUrl: string;
  readonly deviceId: DeviceId;
  readonly deviceToken: string;
  readonly requestTimeoutMs: number;
  readonly backoffInitialMs: number;
  readonly backoffMaxMs: number;
}

export interface RuntimeDependencies {
  readonly openStore: (sqlitePath: string) => LocalStore;
  readonly openNetwork: (config: NetworkBootstrapConfig, logger: JsonLogger) => BackendGateway;
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
  readonly localStore: LocalStore;
  readonly backendGateway: BackendGateway;
  readonly deviceStateReporter: DeviceStateReporter;
  readonly scheduleSyncService: ScheduleSyncService;
  readonly commandPoller: CommandPoller;
  readonly manualCommandQueue: ManualCommandQueue;
  readonly digitalTwin: ReturnType<typeof createDigitalTwin>;
  readonly simulatorControlServer: SimulatorControlServer;
  readonly feedingOrchestrator: FeedingOrchestrator;
  readonly localScheduler: LocalScheduler;
}

const defaultDependencies: RuntimeDependencies = Object.freeze({
  openStore: (sqlitePath: string) => SqliteLocalStore.open({ databasePath: sqlitePath }),
  openNetwork: (config: NetworkBootstrapConfig, logger: JsonLogger) => new HttpBackendGateway({
    backendUrl: config.backendUrl,
    deviceId: config.deviceId,
    deviceToken: config.deviceToken,
    requestTimeoutMs: config.requestTimeoutMs,
    backoffInitialMs: config.backoffInitialMs,
    backoffMaxMs: config.backoffMaxMs,
    logger,
  }),
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
  let localStore: LocalStore;
  let backendGateway: BackendGateway;
  let deviceStateReporter: DeviceStateReporter;
  let scheduleSyncService: ScheduleSyncService;
  let commandPoller: CommandPoller;
  let manualCommandQueue: ManualCommandQueue;
  let digitalTwin: ReturnType<typeof createDigitalTwin>;
  let simulatorControlServer: SimulatorControlServer;
  let feedingOrchestrator: FeedingOrchestrator;
  let localScheduler: LocalScheduler;
  try {
    localStore = dependencies.openStore(config.sqlitePath);
    resources.push(localStore);
    backendGateway = dependencies.openNetwork({
      backendUrl: config.backendUrl,
      deviceId: config.deviceId,
      deviceToken: config.deviceToken,
      requestTimeoutMs: config.requestTimeoutMs,
      backoffInitialMs: config.backoff.initialMs,
      backoffMaxMs: config.backoff.maxMs,
    }, logger);
    resources.push(backendGateway);
    const clock = new SystemClock();
    deviceStateReporter = new DeviceStateReporter({
      deviceId: config.deviceId,
      firmwareVersion: serviceMetadata.version,
      heartbeatIntervalMs: config.intervals.heartbeatMs,
      maxClockSkewMs: config.maxClockSkewMs,
      gateway: backendGateway,
      store: localStore,
      clock,
      logger,
    });
    scheduleSyncService = new ScheduleSyncService({
      deviceId: config.deviceId,
      syncIntervalMs: config.intervals.scheduleSyncMs,
      gateway: backendGateway,
      store: localStore,
      clock,
      logger,
    });
    commandPoller = new CommandPoller({
      deviceId: config.deviceId,
      pollIntervalMs: config.intervals.commandPollMs,
      gateway: backendGateway,
      store: localStore,
      clock,
      logger,
    });
    manualCommandQueue = new ManualCommandQueue({
      store: localStore,
      gateway: backendGateway,
      clock,
      maxClockSkewMs: config.maxClockSkewMs,
    });
    const telemetry = new LoggerTelemetry(logger);
    digitalTwin = createDigitalTwin({
      seed: config.simulator.seed,
      initialTime: (options.now ?? (() => new Date()))(),
      scenario: config.simulator.scenario,
      telemetry,
      autoAdvance: config.simulator.autoAdvance,
    });
    simulatorControlServer = new SimulatorControlServer(
      digitalTwin.controller,
      config.simulator.socketPath,
    );
    feedingOrchestrator = new FeedingOrchestrator({
      store: localStore,
      executionLock: digitalTwin.executionLock,
      motor: digitalTwin.motor,
      weightSensor: digitalTwin.weightSensor,
      clock,
      deviceStateReporter,
      telemetry,
      maximumExecutionMs: config.feedingTimeoutMs,
    });
    localScheduler = new LocalScheduler({
      store: localStore,
      backendGateway,
      clock,
      idGenerator: digitalTwin.idGenerator,
      feedingOrchestrator,
      telemetry,
      logger,
      tickIntervalMs: config.scheduler.tickMs,
      maximumLatenessMs: config.scheduler.maxLatenessMs,
    });
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
    localStore,
    backendGateway,
    deviceStateReporter,
    scheduleSyncService,
    commandPoller,
    manualCommandQueue,
    digitalTwin,
    simulatorControlServer,
    feedingOrchestrator,
    localScheduler,
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
