import { setTimeout as sleepWithSignal } from 'node:timers/promises';

import { z } from 'zod';

import {
  acknowledgeCommandRequestSchema,
  acknowledgeCommandResponseSchema,
  apiErrorResponseSchema,
  deviceApiPaths,
  manualFeedingResultRequestSchema,
  manualFeedingResultResponseSchema,
  pendingCommandsResponseSchema,
  reportDeviceStateRequestSchema,
  reportDeviceStateResponseSchema,
  scheduledFeedingEventRequestSchema,
  scheduledFeedingEventResponseSchema,
  scheduleSyncResponseSchema,
  type AcknowledgeCommandRequest,
  type AcknowledgeCommandResponse,
  type ManualFeedingResultRequest,
  type ManualFeedingResultResponse,
  type PendingCommandsResponse,
  type ReportDeviceStateRequest,
  type ReportDeviceStateResponse,
  type ScheduledFeedingEventRequest,
  type ScheduledFeedingEventResponse,
  type ScheduleSyncResponse,
} from '../../contracts/index.js';
import {
  commandIdSchema,
  feedingIdSchema,
  type CommandId,
  type DeviceId,
  type FeedingId,
} from '../../domain/index.js';
import type { JsonLogger } from '../../observability/index.js';
import {
  BackendConfigurationError,
  BackendConflictError,
  BackendContractError,
  BackendCredentialError,
  BackendGatewayClosedError,
  BackendHttpError,
  BackendTransportError,
  type BackendGateway,
  type BackendGatewayResult,
} from '../../ports/index.js';

const maximumResponseBytes = 1_048_576;
const noOpLogger: JsonLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

type FetchImplementation = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;
type SleepImplementation = (delayMs: number, signal: AbortSignal) => Promise<void>;

interface RequestPlan<T> {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: string;
  readonly body: string | undefined;
  readonly responseSchema: z.ZodType<T>;
}

interface BackendErrorPayload {
  readonly requestId: string | null;
  readonly backendCode: string | null;
}

export interface HttpBackendGatewayOptions {
  readonly backendUrl: string;
  readonly deviceId: DeviceId;
  readonly deviceToken: string;
  readonly requestTimeoutMs: number;
  readonly backoffInitialMs: number;
  readonly backoffMaxMs: number;
  readonly maxAttempts?: number | undefined;
  readonly fetchImplementation?: FetchImplementation | undefined;
  readonly sleep?: SleepImplementation | undefined;
  readonly logger?: JsonLogger | undefined;
}

export class HttpBackendGateway implements BackendGateway {
  private readonly backendUrl: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly sleep: SleepImplementation;
  private readonly logger: JsonLogger;
  private readonly lifecycle = new AbortController();
  private readonly maxAttempts: number;

  constructor(private readonly options: HttpBackendGatewayOptions) {
    this.backendUrl = new URL(options.backendUrl).origin;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger ?? noOpLogger;
    this.maxAttempts = options.maxAttempts ?? 3;
    assertPositiveInteger(options.requestTimeoutMs, 'requestTimeoutMs');
    assertPositiveInteger(options.backoffInitialMs, 'backoffInitialMs');
    assertPositiveInteger(options.backoffMaxMs, 'backoffMaxMs');
    assertPositiveInteger(this.maxAttempts, 'maxAttempts');
    if (options.backoffInitialMs > options.backoffMaxMs) {
      throw new RangeError('backoffInitialMs must not exceed backoffMaxMs');
    }
  }

  reportState(
    request: ReportDeviceStateRequest,
  ): Promise<BackendGatewayResult<ReportDeviceStateResponse>> {
    const body = serializeRequest(reportDeviceStateRequestSchema, request);
    return this.execute({
      method: 'PUT',
      path: deviceApiPaths.state(this.options.deviceId),
      body,
      responseSchema: reportDeviceStateResponseSchema,
    });
  }

  syncSchedules(knownRevision: number): Promise<BackendGatewayResult<ScheduleSyncResponse>> {
    return this.execute({
      method: 'GET',
      path: deviceApiPaths.schedules(this.options.deviceId, knownRevision),
      body: undefined,
      responseSchema: scheduleSyncResponseSchema,
    });
  }

  getPendingCommands(limit = 10): Promise<BackendGatewayResult<PendingCommandsResponse>> {
    return this.execute({
      method: 'GET',
      path: deviceApiPaths.pendingCommands(this.options.deviceId, limit),
      body: undefined,
      responseSchema: pendingCommandsResponseSchema,
    });
  }

  acknowledgeCommand(
    commandId: CommandId,
    request: AcknowledgeCommandRequest,
  ): Promise<BackendGatewayResult<AcknowledgeCommandResponse>> {
    const validatedCommandId = commandIdSchema.parse(commandId);
    const body = serializeRequest(acknowledgeCommandRequestSchema, request);
    return this.execute({
      method: 'POST',
      path: deviceApiPaths.acknowledgeCommand(this.options.deviceId, validatedCommandId),
      body,
      responseSchema: acknowledgeCommandResponseSchema,
    });
  }

  reportManualFeedingResult(
    feedingId: FeedingId,
    request: ManualFeedingResultRequest | string,
  ): Promise<BackendGatewayResult<ManualFeedingResultResponse>> {
    const validatedFeedingId = feedingIdSchema.parse(feedingId);
    const body = serializeRequest(manualFeedingResultRequestSchema, request);
    return this.execute({
      method: 'POST',
      path: deviceApiPaths.feedingResult(this.options.deviceId, validatedFeedingId),
      body,
      responseSchema: manualFeedingResultResponseSchema,
    }, typeof request === 'string' ? 1 : this.maxAttempts);
  }

  reportScheduledFeedingEvent(
    request: ScheduledFeedingEventRequest | string,
  ): Promise<BackendGatewayResult<ScheduledFeedingEventResponse>> {
    const body = serializeRequest(scheduledFeedingEventRequestSchema, request);
    return this.execute({
      method: 'POST',
      path: deviceApiPaths.feedingEvents(this.options.deviceId),
      body,
      responseSchema: scheduledFeedingEventResponseSchema,
    }, typeof request === 'string' ? 1 : this.maxAttempts);
  }

  close(): void {
    if (!this.lifecycle.signal.aborted) this.lifecycle.abort();
  }

  private async execute<T>(plan: RequestPlan<T>, maxAttempts = this.maxAttempts): Promise<BackendGatewayResult<T>> {
    this.assertOpen();
    let lastTransportCause: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.logger.debug('backend_request_attempt', {
        method: plan.method,
        path: plan.path,
        attempt,
      });

      let response: Response;
      let responseText: string;
      try {
        ({ response, responseText } = await this.fetchAttempt(plan));
      } catch (error) {
        if (error instanceof BackendContractError) throw error;
        if (this.lifecycle.signal.aborted) throw new BackendGatewayClosedError();
        lastTransportCause = error;
        if (attempt === maxAttempts) {
          throw new BackendTransportError(attempt, lastTransportCause);
        }
        await this.waitBeforeRetry(plan, attempt, null, null);
        continue;
      }

      const headerRequestId = response.headers.get('x-request-id')
        ?? response.headers.get('request-id');
      if (response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().startsWith('application/json')) {
          throw new BackendContractError(headerRequestId);
        }
        const data = parseSuccessResponse(plan.responseSchema, responseText, headerRequestId);
        return Object.freeze({ data, requestId: headerRequestId });
      }

      const errorPayload = parseBackendError(responseText, headerRequestId);
      if (response.status === 401) {
        throw new BackendCredentialError(errorPayload.requestId, errorPayload.backendCode);
      }
      if (response.status === 403) {
        throw new BackendConfigurationError(errorPayload.requestId, errorPayload.backendCode);
      }
      if (response.status === 409) {
        throw new BackendConflictError(errorPayload.requestId, errorPayload.backendCode);
      }

      const retryable = isRetryableStatus(response.status);
      if (!retryable || attempt === maxAttempts) {
        throw new BackendHttpError({
          statusCode: response.status,
          requestId: errorPayload.requestId,
          backendCode: errorPayload.backendCode,
          retryable,
          attempts: attempt,
        });
      }
      await this.waitBeforeRetry(
        plan,
        attempt,
        response.status,
        errorPayload.requestId,
      );
    }

    throw new BackendTransportError(maxAttempts, lastTransportCause);
  }

  private async fetchAttempt<T>(plan: RequestPlan<T>): Promise<{
    response: Response;
    responseText: string;
  }> {
    this.assertOpen();
    const controller = new AbortController();
    const abortForClose = (): void => controller.abort();
    this.lifecycle.signal.addEventListener('abort', abortForClose, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    timeout.unref();
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${this.options.deviceToken}`,
      };
      if (plan.body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
      const requestInit: RequestInit = {
        method: plan.method,
        headers,
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      };
      if (plan.body !== undefined) requestInit.body = plan.body;
      const response = await this.fetchImplementation(
        new URL(plan.path, this.backendUrl),
        requestInit,
      );
      let responseText = '';
      try {
        responseText = await readResponseText(response);
      } catch (error) {
        if (response.ok || this.lifecycle.signal.aborted) throw error;
        // Unreadable diagnostics must not alter the HTTP error classification.
        controller.abort();
      }
      return { response, responseText };
    } finally {
      clearTimeout(timeout);
      this.lifecycle.signal.removeEventListener('abort', abortForClose);
    }
  }

  private async waitBeforeRetry<T>(
    plan: RequestPlan<T>,
    attempt: number,
    statusCode: number | null,
    requestId: string | null,
  ): Promise<void> {
    const delayMs = Math.min(
      this.options.backoffInitialMs * (2 ** (attempt - 1)),
      this.options.backoffMaxMs,
    );
    this.logger.warn('backend_request_retry_scheduled', {
      method: plan.method,
      path: plan.path,
      attempt,
      delayMs,
      statusCode,
      requestId,
    });
    try {
      await this.sleep(delayMs, this.lifecycle.signal);
    } catch (error) {
      if (this.lifecycle.signal.aborted) throw new BackendGatewayClosedError();
      throw new BackendTransportError(attempt, error);
    }
  }

  private assertOpen(): void {
    if (this.lifecycle.signal.aborted) throw new BackendGatewayClosedError();
  }
}

function serializeRequest<T>(schema: z.ZodType<T>, request: T | string): string {
  if (typeof request === 'string') {
    schema.parse(JSON.parse(request) as unknown);
    return request;
  }
  return JSON.stringify(schema.parse(request));
}

async function readResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes) {
    throw new BackendContractError(response.headers.get('x-request-id'));
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maximumResponseBytes) {
    throw new BackendContractError(response.headers.get('x-request-id'));
  }
  return text;
}

function parseSuccessResponse<T>(
  schema: z.ZodType<T>,
  text: string,
  requestId: string | null,
): T {
  try {
    return schema.parse(JSON.parse(text) as unknown);
  } catch (error) {
    throw new BackendContractError(requestId, error);
  }
}

function parseBackendError(text: string, headerRequestId: string | null): BackendErrorPayload {
  try {
    const parsed = apiErrorResponseSchema.safeParse(JSON.parse(text) as unknown);
    if (parsed.success) {
      return {
        requestId: parsed.data.error.request_id,
        backendCode: parsed.data.error.code,
      };
    }
  } catch {
    // A malformed error response keeps its HTTP classification but exposes no body.
  }
  return { requestId: headerRequestId, backendCode: null };
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

async function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  await sleepWithSignal(delayMs, undefined, { signal });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
