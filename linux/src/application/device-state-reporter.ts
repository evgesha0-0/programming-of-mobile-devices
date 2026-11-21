import {
  errorCodeSchema,
  errorMessageSchema,
  reportedDeviceStatusSchema,
  utcDateTimeSchema,
  type DeviceId,
  type ReportedDeviceStatus,
} from '../domain/index.js';
import type { ReportDeviceStateRequest } from '../contracts/index.js';
import type { JsonLogger } from '../observability/index.js';
import {
  BackendContractError,
  BackendGatewayError,
  type BackendGateway,
  type Clock,
  type LocalStore,
} from '../ports/index.js';

export interface DeviceStateReporterOptions {
  readonly deviceId: DeviceId;
  readonly firmwareVersion: string;
  readonly heartbeatIntervalMs: number;
  readonly maxClockSkewMs: number;
  readonly gateway: BackendGateway;
  readonly store: LocalStore;
  readonly clock: Clock;
  readonly logger: JsonLogger;
}

export interface DeviceStateValue {
  readonly status: ReportedDeviceStatus;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface DeviceStateReportResult {
  readonly payload: ReportDeviceStateRequest;
  readonly serverTime: string;
  readonly clockOffsetMs: number;
  readonly requestId: string | null;
}

export class ClockSkewExceededError extends Error {
  readonly clockOffsetMs: number;
  readonly maximumMs: number;

  constructor(clockOffsetMs: number, maximumMs: number) {
    super(`Backend clock offset ${clockOffsetMs}ms exceeds the ${maximumMs}ms limit`);
    this.name = 'ClockSkewExceededError';
    this.clockOffsetMs = clockOffsetMs;
    this.maximumMs = maximumMs;
  }
}

export class HeartbeatPersistenceError extends Error {
  constructor() {
    super('Pending heartbeat could not be marked as delivered');
    this.name = 'HeartbeatPersistenceError';
  }
}

export class DeviceStateReporter {
  private state: DeviceStateValue = Object.freeze({
    status: 'online',
    errorCode: null,
    errorMessage: null,
  });
  private running = false;

  constructor(private readonly options: DeviceStateReporterOptions) {
    if (options.firmwareVersion.trim().length === 0 || options.firmwareVersion.length > 64) {
      throw new RangeError('firmwareVersion must contain 1..64 characters');
    }
    assertPositiveSafeInteger(options.heartbeatIntervalMs, 'heartbeatIntervalMs');
    if (!Number.isSafeInteger(options.maxClockSkewMs) || options.maxClockSkewMs < 0) {
      throw new RangeError('maxClockSkewMs must be a nonnegative safe integer');
    }
  }

  getState(): DeviceStateValue {
    return this.state;
  }

  setState(
    status: ReportedDeviceStatus,
    errorCode: string | null = null,
    errorMessage: string | null = null,
  ): void {
    const parsedStatus = reportedDeviceStatusSchema.parse(status);
    const parsedErrorCode = errorCodeSchema.nullable().parse(errorCode);
    const parsedErrorMessage = errorMessageSchema.nullable().parse(errorMessage);
    if (parsedStatus !== 'error' && (parsedErrorCode !== null || parsedErrorMessage !== null)) {
      throw new TypeError('Only error status may include error details');
    }
    this.state = Object.freeze({
      status: parsedStatus,
      errorCode: parsedErrorCode,
      errorMessage: parsedErrorMessage,
    });
  }

  async reportNow(): Promise<DeviceStateReportResult> {
    const stored = this.options.store.getLastHeartbeat();
    const payload = stored?.deliveryState === 'pending'
      ? stored.payload
      : this.createNextPayload(stored?.payload.reported_at ?? null);
    if (stored?.deliveryState !== 'pending') {
      this.options.store.savePendingHeartbeat(payload);
    }

    const sentAtMs = this.readClockMilliseconds();
    const response = await this.options.gateway.reportState(payload);
    const receivedAtMs = this.readClockMilliseconds();
    if (response.data.device_id !== this.options.deviceId) {
      throw new BackendContractError(response.requestId);
    }
    if (Date.parse(response.data.last_seen_at) !== Date.parse(payload.reported_at)) {
      throw new BackendContractError(response.requestId);
    }

    const serverTime = utcDateTimeSchema.parse(response.data.server_time);
    const clockOffsetMs = Math.round(
      Date.parse(serverTime) - ((sentAtMs + receivedAtMs) / 2),
    );
    const delivered = this.options.store.markHeartbeatDelivered({
      reportedAt: payload.reported_at,
      serverTime,
      clockOffsetMs,
      requestId: response.requestId,
    });
    if (!delivered) throw new HeartbeatPersistenceError();

    this.options.logger.info('device_state_reported', {
      status: payload.status,
      reportedAt: payload.reported_at,
      serverTime,
      clockOffsetMs,
      requestId: response.requestId,
    });
    if (Math.abs(clockOffsetMs) > this.options.maxClockSkewMs) {
      throw new ClockSkewExceededError(clockOffsetMs, this.options.maxClockSkewMs);
    }
    return Object.freeze({
      payload,
      serverTime,
      clockOffsetMs,
      requestId: response.requestId,
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error('DeviceStateReporter is already running');
    this.running = true;
    try {
      while (!signal.aborted) {
        try {
          await this.reportNow();
        } catch (error) {
          if (signal.aborted) break;
          this.options.logger.error('device_state_report_failed', { error });
          if (!isRetryableGatewayError(error)) throw error;
        }
        try {
          await this.options.clock.sleep(this.options.heartbeatIntervalMs, signal);
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private createNextPayload(lastReportedAt: string | null): ReportDeviceStateRequest {
    const nowMs = this.readClockMilliseconds();
    const lastReportedMs = lastReportedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(lastReportedAt);
    const reportedAtMs = Math.max(nowMs, lastReportedMs + 1);
    return {
      status: this.state.status,
      reported_at: utcDateTimeSchema.parse(new Date(reportedAtMs).toISOString()),
      firmware_version: this.options.firmwareVersion,
      error_code: this.state.errorCode,
      error_message: this.state.errorMessage,
    };
  }

  private readClockMilliseconds(): number {
    const milliseconds = this.options.clock.now().getTime();
    if (!Number.isFinite(milliseconds)) throw new Error('Clock returned an invalid date');
    return milliseconds;
  }
}

function isRetryableGatewayError(error: unknown): boolean {
  return error instanceof BackendGatewayError && error.disposition === 'retryable';
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
