import 'dotenv/config';

export type NodeEnvironment = 'development' | 'test' | 'production';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  host: string;
  port: number;
  logLevel: string;
  database: DatabaseConfig;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
  return Object.freeze({
    nodeEnv: getNodeEnvironment(source.NODE_ENV),
    host: source.HOST?.trim() || '0.0.0.0',
    port: getPort(source.PORT, 'PORT', 3000),
    logLevel: source.LOG_LEVEL?.trim() || 'info',
    database: Object.freeze({
      host: getRequiredValue(source.DB_HOST, 'DB_HOST'),
      port: getPort(source.DB_PORT, 'DB_PORT', 5432),
      database: getRequiredValue(source.DB_NAME, 'DB_NAME'),
      user: getRequiredValue(source.DB_USER, 'DB_USER'),
      password: getRequiredValue(source.DB_PASSWORD, 'DB_PASSWORD'),
    }),
  });
}

function getNodeEnvironment(value: string | undefined): NodeEnvironment {
  const nodeEnv = value?.trim() || 'development';

  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('Environment variable NODE_ENV must be development, test, or production');
  }

  return nodeEnv as NodeEnvironment;
}

function getRequiredValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();

  if (!normalized) {
    throw new Error(`Environment variable ${name} is required`);
  }

  return normalized;
}

function getPort(value: string | undefined, name: string, defaultValue: number): number {
  const port = Number(value ?? defaultValue);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Environment variable ${name} must be an integer from 1 to 65535`);
  }

  return port;
}
