import type {
  AcknowledgeCommandRequest,
  AcknowledgeCommandResponse,
  ManualFeedingResultRequest,
  ManualFeedingResultResponse,
  PendingCommandsResponse,
  ReportDeviceStateRequest,
  ReportDeviceStateResponse,
  ScheduledFeedingEventRequest,
  ScheduledFeedingEventResponse,
  ScheduleSyncResponse,
} from '../contracts/index.js';
import type { CommandId, FeedingId } from '../domain/index.js';

export interface BackendGatewayResult<T> {
  readonly data: T;
  readonly requestId: string | null;
}

export interface BackendGateway {
  reportState(
    request: ReportDeviceStateRequest,
  ): Promise<BackendGatewayResult<ReportDeviceStateResponse>>;
  syncSchedules(knownRevision: number): Promise<BackendGatewayResult<ScheduleSyncResponse>>;
  getPendingCommands(limit?: number): Promise<BackendGatewayResult<PendingCommandsResponse>>;
  acknowledgeCommand(
    commandId: CommandId,
    request: AcknowledgeCommandRequest,
  ): Promise<BackendGatewayResult<AcknowledgeCommandResponse>>;
  reportManualFeedingResult(
    feedingId: FeedingId,
    request: ManualFeedingResultRequest,
  ): Promise<BackendGatewayResult<ManualFeedingResultResponse>>;
  reportScheduledFeedingEvent(
    request: ScheduledFeedingEventRequest,
  ): Promise<BackendGatewayResult<ScheduledFeedingEventResponse>>;
  close(): void;
}

export type BackendErrorDisposition =
  | 'credential'
  | 'configuration'
  | 'quarantine'
  | 'retryable'
  | 'fatal';

export interface BackendGatewayErrorOptions {
  readonly disposition: BackendErrorDisposition;
  readonly requestId?: string | null;
  readonly statusCode?: number | null;
  readonly backendCode?: string | null;
  readonly attempts?: number;
  readonly cause?: unknown;
}

export class BackendGatewayError extends Error {
  readonly disposition: BackendErrorDisposition;
  readonly requestId: string | null;
  readonly statusCode: number | null;
  readonly backendCode: string | null;
  readonly attempts: number;

  constructor(message: string, options: BackendGatewayErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'BackendGatewayError';
    this.disposition = options.disposition;
    this.requestId = options.requestId ?? null;
    this.statusCode = options.statusCode ?? null;
    this.backendCode = options.backendCode ?? null;
    this.attempts = options.attempts ?? 1;
  }
}

export class BackendCredentialError extends BackendGatewayError {
  constructor(requestId: string | null, backendCode: string | null) {
    super('Backend rejected device credentials', {
      disposition: 'credential',
      requestId,
      statusCode: 401,
      backendCode,
    });
    this.name = 'BackendCredentialError';
  }
}

export class BackendConfigurationError extends BackendGatewayError {
  constructor(requestId: string | null, backendCode: string | null) {
    super('Backend rejected device identity configuration', {
      disposition: 'configuration',
      requestId,
      statusCode: 403,
      backendCode,
    });
    this.name = 'BackendConfigurationError';
  }
}

export class BackendConflictError extends BackendGatewayError {
  constructor(requestId: string | null, backendCode: string | null) {
    super('Backend reported conflicting operation content', {
      disposition: 'quarantine',
      requestId,
      statusCode: 409,
      backendCode,
    });
    this.name = 'BackendConflictError';
  }
}

export class BackendHttpError extends BackendGatewayError {
  constructor(options: {
    readonly statusCode: number;
    readonly requestId: string | null;
    readonly backendCode: string | null;
    readonly retryable: boolean;
    readonly attempts: number;
  }) {
    super(`Backend request failed with HTTP ${options.statusCode}`, {
      disposition: options.retryable ? 'retryable' : 'fatal',
      requestId: options.requestId,
      statusCode: options.statusCode,
      backendCode: options.backendCode,
      attempts: options.attempts,
    });
    this.name = 'BackendHttpError';
  }
}

export class BackendTransportError extends BackendGatewayError {
  constructor(attempts: number, cause: unknown) {
    super(`Backend transport failed after ${attempts} attempt(s)`, {
      disposition: 'retryable',
      attempts,
      cause,
    });
    this.name = 'BackendTransportError';
  }
}

export class BackendContractError extends BackendGatewayError {
  constructor(requestId: string | null, cause?: unknown) {
    super('Backend response does not match the device contract', {
      disposition: 'fatal',
      requestId,
      cause,
    });
    this.name = 'BackendContractError';
  }
}

export class BackendGatewayClosedError extends BackendGatewayError {
  constructor() {
    super('Backend gateway is closed', { disposition: 'fatal' });
    this.name = 'BackendGatewayClosedError';
  }
}
