import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z, ZodError } from 'zod';

import { deviceIdSchema, type DeviceId } from '../domain/index.js';

const deviceTokenPattern = /^dvc_[A-Za-z0-9_-]{43}$/;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  HARDWARE_ADAPTER: z.literal('simulator').default('simulator'),
  BACKEND_URL: z.string().min(1),
  DEVICE_ID: deviceIdSchema,
  DEVICE_TOKEN: z.string().optional(),
  DEVICE_TOKEN_FILE: z.string().min(1).optional(),
  SQLITE_PATH: z.string().min(1),
  HEARTBEAT_INTERVAL_MS: integerEnvironmentValue(30_000, 1_000, 60_000),
  SCHEDULE_SYNC_INTERVAL_MS: integerEnvironmentValue(60_000, 5_000, 3_600_000),
  COMMAND_POLL_INTERVAL_MS: integerEnvironmentValue(5_000, 1_000, 60_000),
  REQUEST_TIMEOUT_MS: integerEnvironmentValue(10_000, 500, 60_000),
  BACKOFF_INITIAL_MS: integerEnvironmentValue(1_000, 100, 60_000),
  BACKOFF_MAX_MS: integerEnvironmentValue(60_000, 100, 600_000),
  MAX_CLOCK_SKEW_MS: integerEnvironmentValue(30_000, 0, 300_000),
}).superRefine((environment, context) => {
  const hasInlineToken = environment.DEVICE_TOKEN !== undefined;
  const hasTokenFile = environment.DEVICE_TOKEN_FILE !== undefined;
  if (hasInlineToken === hasTokenFile) {
    context.addIssue({
      code: 'custom',
      path: ['DEVICE_TOKEN'],
      message: 'Configure exactly one of DEVICE_TOKEN or DEVICE_TOKEN_FILE',
    });
  }
  if (environment.BACKOFF_INITIAL_MS > environment.BACKOFF_MAX_MS) {
    context.addIssue({
      code: 'custom',
      path: ['BACKOFF_INITIAL_MS'],
      message: 'BACKOFF_INITIAL_MS must not exceed BACKOFF_MAX_MS',
    });
  }
});

export type NodeEnvironment = 'development' | 'test' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeConfig {
  readonly nodeEnvironment: NodeEnvironment;
  readonly logLevel: LogLevel;
  readonly hardwareAdapter: 'simulator';
  readonly backendUrl: string;
  readonly deviceId: DeviceId;
  readonly deviceToken: string;
  readonly sqlitePath: string;
  readonly intervals: Readonly<{
    heartbeatMs: number;
    scheduleSyncMs: number;
    commandPollMs: number;
  }>;
  readonly requestTimeoutMs: number;
  readonly backoff: Readonly<{
    initialMs: number;
    maxMs: number;
  }>;
  readonly maxClockSkewMs: number;
}

export interface RuntimeConfigSummary {
  readonly nodeEnvironment: NodeEnvironment;
  readonly logLevel: LogLevel;
  readonly hardwareAdapter: 'simulator';
  readonly backendUrl: string;
  readonly deviceId: DeviceId;
  readonly sqlitePath: string;
  readonly intervals: RuntimeConfig['intervals'];
  readonly requestTimeoutMs: number;
  readonly backoff: RuntimeConfig['backoff'];
  readonly maxClockSkewMs: number;
}

export interface LoadRuntimeConfigOptions {
  readonly cwd?: string | undefined;
  readonly readSecretFile?: ((path: string) => string) | undefined;
}

export class RuntimeConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid runtime configuration: ${issues.join('; ')}`);
    this.name = 'RuntimeConfigurationError';
    this.issues = Object.freeze([...issues]);
  }
}

export function loadRuntimeConfig(
  source: Readonly<Record<string, string | undefined>>,
  options: LoadRuntimeConfigOptions = {},
): RuntimeConfig {
  let environment: z.infer<typeof environmentSchema>;
  try {
    environment = environmentSchema.parse(source);
  } catch (error) {
    if (error instanceof ZodError) throw configurationErrorFromZod(error);
    throw error;
  }

  const cwd = options.cwd ?? process.cwd();
  const backendUrl = parseBackendUrl(environment.BACKEND_URL, environment.NODE_ENV);
  const sqlitePath = parseSqlitePath(environment.SQLITE_PATH, cwd);
  const deviceToken = resolveDeviceToken(environment, cwd, options.readSecretFile);

  return Object.freeze({
    nodeEnvironment: environment.NODE_ENV,
    logLevel: environment.LOG_LEVEL,
    hardwareAdapter: environment.HARDWARE_ADAPTER,
    backendUrl,
    deviceId: environment.DEVICE_ID,
    deviceToken,
    sqlitePath,
    intervals: Object.freeze({
      heartbeatMs: environment.HEARTBEAT_INTERVAL_MS,
      scheduleSyncMs: environment.SCHEDULE_SYNC_INTERVAL_MS,
      commandPollMs: environment.COMMAND_POLL_INTERVAL_MS,
    }),
    requestTimeoutMs: environment.REQUEST_TIMEOUT_MS,
    backoff: Object.freeze({
      initialMs: environment.BACKOFF_INITIAL_MS,
      maxMs: environment.BACKOFF_MAX_MS,
    }),
    maxClockSkewMs: environment.MAX_CLOCK_SKEW_MS,
  });
}

export function runtimeConfigSummary(config: RuntimeConfig): RuntimeConfigSummary {
  return Object.freeze({
    nodeEnvironment: config.nodeEnvironment,
    logLevel: config.logLevel,
    hardwareAdapter: config.hardwareAdapter,
    backendUrl: config.backendUrl,
    deviceId: config.deviceId,
    sqlitePath: config.sqlitePath,
    intervals: config.intervals,
    requestTimeoutMs: config.requestTimeoutMs,
    backoff: config.backoff,
    maxClockSkewMs: config.maxClockSkewMs,
  });
}

function integerEnvironmentValue(defaultValue: number, minimum: number, maximum: number) {
  return z.preprocess((value) => {
    if (value === undefined) return defaultValue;
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return value;
    return Number(value);
  }, z.number().int().min(minimum).max(maximum));
}

function parseBackendUrl(value: string, nodeEnvironment: NodeEnvironment): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeConfigurationError(['BACKEND_URL must be an absolute URL']);
  }

  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new RuntimeConfigurationError([
      'BACKEND_URL must contain only scheme, host and optional port',
    ]);
  }
  if (url.protocol === 'https:') return url.origin;
  if (
    url.protocol === 'http:'
    && nodeEnvironment !== 'production'
    && loopbackHosts.has(url.hostname.toLowerCase())
  ) {
    return url.origin;
  }
  throw new RuntimeConfigurationError([
    'BACKEND_URL must use HTTPS; development HTTP is limited to loopback hosts',
  ]);
}

function parseSqlitePath(value: string, cwd: string): string {
  if (value !== value.trim() || value.includes('\0') || value === ':memory:') {
    throw new RuntimeConfigurationError([
      'SQLITE_PATH must be a persistent file path without surrounding whitespace',
    ]);
  }
  return resolve(cwd, value);
}

function resolveDeviceToken(
  environment: z.infer<typeof environmentSchema>,
  cwd: string,
  readSecretFile: ((path: string) => string) | undefined,
): string {
  let token: string;
  if (environment.DEVICE_TOKEN !== undefined) {
    token = environment.DEVICE_TOKEN;
  } else {
    const configuredPath = environment.DEVICE_TOKEN_FILE;
    if (configuredPath === undefined || configuredPath !== configuredPath.trim()) {
      throw new RuntimeConfigurationError(['DEVICE_TOKEN_FILE must be a valid file path']);
    }
    try {
      token = (readSecretFile ?? defaultSecretFileReader)(resolve(cwd, configuredPath));
    } catch {
      throw new RuntimeConfigurationError(['DEVICE_TOKEN_FILE could not be read']);
    }
    token = removeSingleTrailingLineBreak(token);
  }

  if (!deviceTokenPattern.test(token)) {
    throw new RuntimeConfigurationError(['DEVICE_TOKEN has an invalid format']);
  }
  return token;
}

function removeSingleTrailingLineBreak(value: string): string {
  const withoutTrailingLineBreak = value.endsWith('\r\n')
    ? value.slice(0, -2)
    : value.endsWith('\n')
      ? value.slice(0, -1)
      : value;
  if (
    withoutTrailingLineBreak.includes('\r')
    || withoutTrailingLineBreak.includes('\n')
    || withoutTrailingLineBreak !== withoutTrailingLineBreak.trim()
  ) {
    throw new RuntimeConfigurationError([
      'DEVICE_TOKEN_FILE must contain exactly one token and an optional trailing line break',
    ]);
  }
  return withoutTrailingLineBreak;
}

function defaultSecretFileReader(path: string): string {
  return readFileSync(path, 'utf8');
}

function configurationErrorFromZod(error: ZodError): RuntimeConfigurationError {
  return new RuntimeConfigurationError(error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'environment';
    return `${path}: ${issue.message}`;
  }));
}
