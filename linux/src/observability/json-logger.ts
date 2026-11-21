import type { LogLevel } from '../config/index.js';

const levelPriority: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});
const sensitiveKeyPattern = /(authorization|credential|password|secret|token)/i;

export interface JsonLogger {
  debug(event: string, fields?: Readonly<object>): void;
  info(event: string, fields?: Readonly<object>): void;
  warn(event: string, fields?: Readonly<object>): void;
  error(event: string, fields?: Readonly<object>): void;
}

export interface JsonLoggerOptions {
  readonly level: LogLevel;
  readonly secrets?: readonly string[];
  readonly sink?: ((line: string) => void) | undefined;
  readonly now?: (() => Date) | undefined;
}

export function createJsonLogger(options: JsonLoggerOptions): JsonLogger {
  const threshold = levelPriority[options.level];
  const secrets = [...new Set(
    (options.secrets ?? []).filter((secret) => secret.length > 0),
  )].sort((left, right) => right.length - left.length);
  const sink = options.sink ?? ((line: string) => process.stdout.write(line));
  const now = options.now ?? (() => new Date());

  function log(
    level: LogLevel,
    event: string,
    fields: Readonly<object> = {},
  ): void {
    if (levelPriority[level] < threshold) return;
    const record = {
      timestamp: now().toISOString(),
      level,
      event: redactString(event, secrets),
      data: sanitize(fields, secrets, new WeakSet<object>()),
    };
    sink(`${JSON.stringify(record)}\n`);
  }

  return Object.freeze({
    debug: (event: string, fields?: Readonly<object>) => log('debug', event, fields),
    info: (event: string, fields?: Readonly<object>) => log('info', event, fields),
    warn: (event: string, fields?: Readonly<object>) => log('warn', event, fields),
    error: (event: string, fields?: Readonly<object>) => log('error', event, fields),
  });
}

function sanitize(
  value: unknown,
  secrets: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (
    value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'undefined'
  ) {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return '[UNSERIALIZABLE]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return sanitize({
      name: value.name,
      message: value.message,
      stack: value.stack,
    }, secrets, seen);
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => sanitize(entry, secrets, seen));
    }
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      sanitized[redactString(key, secrets)] = sensitiveKeyPattern.test(key)
        ? '[REDACTED]'
        : sanitize(entry, secrets, seen);
    }
    return sanitized;
  } finally {
    seen.delete(value);
  }
}

function redactString(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, '[REDACTED]');
  return redacted;
}
