import type { Telemetry, TelemetryFields } from '../ports/index.js';
import type { JsonLogger } from './json-logger.js';

export class LoggerTelemetry implements Telemetry {
  constructor(private readonly logger: JsonLogger) {}

  event(name: string, fields: TelemetryFields = {}): void {
    this.logger.info(`telemetry.${name}`, fields);
  }

  increment(name: string, value = 1, fields: TelemetryFields = {}): void {
    this.logger.debug('telemetry.counter', { ...fields, name, value });
  }

  gauge(name: string, value: number, fields: TelemetryFields = {}): void {
    this.logger.debug('telemetry.gauge', { ...fields, name, value });
  }
}
