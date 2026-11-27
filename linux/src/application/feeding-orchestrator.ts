import {
  manualFeedingResultRequestSchema,
  scheduledFeedingEventRequestSchema,
  type ManualFeedingResultRequest,
  type ScheduledFeedingEventRequest,
} from '../contracts/index.js';
import { utcDateTimeSchema, type FeedingId, type UtcDateTime } from '../domain/index.js';
import type { DeviceStateReporter } from './device-state-reporter.js';
import type { ManualCommandQueue } from './manual-command-queue.js';
import { BackendGatewayError } from '../ports/index.js';
import type {
  Clock,
  ExecutionLock,
  FeedingCompletion,
  FeedingIntent,
  LocalStore,
  MotorPort,
  ScheduledFeedingIntent,
  Telemetry,
  WeightSensorPort,
} from '../ports/index.js';
import {
  MotorJammedError,
  WeightSensorDisconnectedError,
  WeightSensorTimeoutError,
} from '../simulator/index.js';

export type FeedingErrorCode = 'MOTOR_ERROR' | 'WEIGHT_SENSOR_ERROR';

export interface FeedingOrchestratorOptions {
  readonly store: LocalStore;
  readonly executionLock: ExecutionLock;
  readonly motor: MotorPort;
  readonly weightSensor: WeightSensorPort;
  readonly clock: Clock;
  readonly deviceStateReporter: DeviceStateReporter;
  readonly telemetry: Telemetry;
  readonly maximumExecutionMs: number;
}

export interface FeedingExecutionResult {
  readonly feedingId: FeedingIntent['feedingId'];
  readonly status: 'completed' | 'failed';
  readonly actualGrams: number | null;
  readonly errorCode: FeedingErrorCode | null;
  readonly errorMessage: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly terminalPayload: string;
  readonly outboxId: number;
}

export class FeedingTimeoutError extends Error {
  constructor() {
    super('Feeding execution exceeded its time limit');
    this.name = 'FeedingTimeoutError';
  }
}

export class DuplicateFeedingExecutionError extends Error {
  constructor(feedingId: string) {
    super(`Feeding ${feedingId} already has a durable execution intent`);
    this.name = 'DuplicateFeedingExecutionError';
  }
}

interface HardwareFailure {
  readonly code: FeedingErrorCode;
  readonly message: string;
  readonly cause: unknown;
}

interface PreparedFeeding {
  readonly intent: FeedingIntent;
  readonly startedAt: UtcDateTime;
  readonly serverAttemptAtMs?: number;
}

export class FeedingOrchestrator {
  constructor(private readonly options: FeedingOrchestratorOptions) {
    if (!Number.isSafeInteger(options.maximumExecutionMs) || options.maximumExecutionMs < 1) {
      throw new RangeError('maximumExecutionMs must be a positive safe integer');
    }
  }

  async execute(intent: ScheduledFeedingIntent, signal: AbortSignal): Promise<FeedingExecutionResult> {
    if (intent.source !== 'scheduled') throw new TypeError('Manual feeding requires a confirmed command');
    const result = await this.executeWithLease(intent.feedingId, signal, () => {
      if (!this.options.store.recordFeedingIntent(intent)) {
        throw new DuplicateFeedingExecutionError(intent.feedingId);
      }
      const startedAt = utcDateTimeSchema.parse(new Date(this.readClockMilliseconds()).toISOString());
      if (!this.options.store.markFeedingRunning(intent.feedingId, startedAt)) {
        throw new DuplicateFeedingExecutionError(intent.feedingId);
      }
      return { intent, startedAt };
    });
    if (result === null) throw new Error('Scheduled feeding unexpectedly skipped');
    return result;
  }

  async executeNextManual(queue: ManualCommandQueue, signal: AbortSignal): Promise<FeedingExecutionResult | null> {
    if (signal.aborted) return null;
    const command = queue.getNextForExecution();
    if (command === null) return null;

    return this.executeWithLease(command.feedingId, signal, async () => {
      if (signal.aborted) return null;
      if (command.phase !== 'acked') {
        const ack = command.phase === 'received'
          ? await queue.acknowledgeFirst(command.commandId)
          : await queue.retryPendingAck(command.commandId);
        if (ack === null || signal.aborted) return null;
      }
      const serverNow = queue.readServerNow();
      if (serverNow === null) return null;
      const attempt = this.options.store.recordManualActuationIntent(command.commandId, serverNow.toISOString());
      return attempt === null ? null : {
        intent: attempt,
        startedAt: attempt.startedAt,
        serverAttemptAtMs: serverNow.getTime(),
      };
    });
  }

  private async executeWithLease(
    feedingId: FeedingId,
    signal: AbortSignal,
    prepare: () => PreparedFeeding | Promise<PreparedFeeding | null>,
  ): Promise<FeedingExecutionResult | null> {
    const lease = await this.options.executionLock.acquire(feedingId, signal);
    try {
      const prepared = await prepare();
      if (prepared === null) return null;
      const { intent, startedAt, serverAttemptAtMs } = prepared;

      this.options.deviceStateReporter.setState('busy');
      this.options.telemetry.event('feeding_execution_started', {
        feedingId: intent.feedingId,
        source: intent.source,
        portionGrams: intent.portionGrams,
      });

      const attemptStartedAtMs = this.readClockMilliseconds();

      let actualGrams: number | null = null;
      let failure: HardwareFailure | null = null;
      let phase: 'sensor' | 'motor' = 'sensor';
      try {
        await this.options.weightSensor.tare(signal);
        signal.throwIfAborted();
        phase = 'motor';
        await this.options.motor.start(signal);

        while (actualGrams === null || actualGrams < intent.portionGrams) {
          if (this.readClockMilliseconds() - attemptStartedAtMs >= this.options.maximumExecutionMs) {
            throw new FeedingTimeoutError();
          }
          phase = 'sensor';
          actualGrams = normalizeActualGrams(await this.options.weightSensor.readGrams(signal));
          phase = 'motor';
          if (this.options.motor.getState() === 'jammed') throw new MotorJammedError();
        }
      } catch (error) {
        failure = mapHardwareFailure(error, phase);
      } finally {
        try {
          if (this.options.motor.getState() !== 'stopped') {
            await this.options.motor.stop(new AbortController().signal);
          }
        } catch (error) {
          this.options.motor.emergencyStop();
          failure = mapHardwareFailure(error, 'motor');
        }
      }

      if (failure?.code !== 'WEIGHT_SENSOR_ERROR') {
        try {
          actualGrams = normalizeActualGrams(
            await this.options.weightSensor.readGrams(new AbortController().signal),
          );
        } catch (error) {
          if (failure === null) failure = mapHardwareFailure(error, 'sensor');
        }
      }

      const deviceFinishedAtMs = this.readClockMilliseconds();
      const elapsedMs = Math.max(0, deviceFinishedAtMs - attemptStartedAtMs);
      const finishedAtMs = Math.max(Date.parse(startedAt), (serverAttemptAtMs ?? attemptStartedAtMs) + elapsedMs);
      const finishedAt = utcDateTimeSchema.parse(new Date(finishedAtMs).toISOString());
      const terminal = buildTerminalPayload(intent, startedAt, finishedAt, actualGrams, failure);
      const terminalPayload = JSON.stringify(terminal.payload);
      const completion: FeedingCompletion = terminal.status === 'completed'
        ? {
            feedingId: intent.feedingId,
            status: 'completed',
            actualGrams: terminal.actualGrams,
            startedAt,
            finishedAt,
            errorCode: null,
            errorMessage: null,
            terminalPayload,
          }
        : {
            feedingId: intent.feedingId,
            status: 'failed',
            actualGrams: terminal.actualGrams,
            startedAt,
            finishedAt,
            errorCode: terminal.errorCode,
            errorMessage: terminal.errorMessage,
            terminalPayload,
          };
      const outboxId = this.options.store.completeFeedingAndEnqueue(completion, {
        kind: intent.source === 'manual' ? 'manual_result' : 'scheduled_event',
        aggregateId: intent.feedingId,
        payload: terminalPayload,
        createdAt: finishedAt,
        nextAttemptAt: intent.source === 'manual' ? new Date(deviceFinishedAtMs).toISOString() : finishedAt,
      });

      if (terminal.status === 'completed') {
        this.options.deviceStateReporter.setState('online');
        this.options.telemetry.increment('feeding_completed', 1, {
          source: intent.source,
        });
      } else {
        this.options.deviceStateReporter.setState(
          'error',
          terminal.errorCode,
          terminal.errorMessage,
        );
        this.options.telemetry.increment('feeding_failed', 1, {
          source: intent.source,
          errorCode: terminal.errorCode,
        });
      }

      return Object.freeze({
        feedingId: intent.feedingId,
        status: terminal.status,
        actualGrams: terminal.actualGrams,
        errorCode: terminal.status === 'failed' ? terminal.errorCode : null,
        errorMessage: terminal.status === 'failed' ? terminal.errorMessage : null,
        startedAt,
        finishedAt,
        terminalPayload,
        outboxId,
      });
    } catch (error) {
      if (!(error instanceof DuplicateFeedingExecutionError || error instanceof BackendGatewayError)) {
        this.options.deviceStateReporter.setState(
          'error',
          'INTERNAL_ERROR',
          'Feeding execution could not be persisted safely',
        );
      }
      throw error;
    } finally {
      lease.release();
    }
  }

  private readClockMilliseconds(): number {
    const milliseconds = this.options.clock.now().getTime();
    if (!Number.isFinite(milliseconds)) throw new Error('Clock returned an invalid date');
    return milliseconds;
  }
}

function buildTerminalPayload(
  intent: FeedingIntent,
  startedAt: string,
  finishedAt: string,
  actualGrams: number | null,
  failure: HardwareFailure | null,
):
  | Readonly<{
      status: 'completed';
      actualGrams: number;
      payload: ManualFeedingResultRequest | ScheduledFeedingEventRequest;
    }>
  | Readonly<{
      status: 'failed';
      actualGrams: number | null;
      errorCode: FeedingErrorCode;
      errorMessage: string;
      payload: ManualFeedingResultRequest | ScheduledFeedingEventRequest;
    }> {
  const status = failure === null ? 'completed' : 'failed';
  const normalizedActual = actualGrams === null ? null : normalizeActualGrams(actualGrams);
  if (status === 'completed' && normalizedActual === null) {
    throw new Error('Completed feeding requires an actual weight');
  }
  const common = {
    portion_grams: intent.portionGrams,
    actual_grams: normalizedActual,
    status,
    started_at: startedAt,
    finished_at: finishedAt,
    error_code: failure?.code ?? null,
    error_message: failure?.message ?? null,
  };
  const payload = intent.source === 'manual'
    ? manualFeedingResultRequestSchema.parse({
        command_id: intent.commandId,
        source: 'manual',
        ...common,
      })
    : scheduledFeedingEventRequestSchema.parse({
        feeding_id: intent.feedingId,
        schedule_id: intent.scheduleId,
        source: 'scheduled',
        created_at: intent.createdAt,
        ...common,
      });
  if (failure === null) {
    return {
      status: 'completed',
      actualGrams: normalizedActual as number,
      payload,
    };
  }
  return {
    status: 'failed',
    actualGrams: normalizedActual,
    errorCode: failure.code,
    errorMessage: failure.message,
    payload,
  };
}

function mapHardwareFailure(
  error: unknown,
  phase: 'sensor' | 'motor',
): HardwareFailure {
  if (error instanceof WeightSensorTimeoutError || error instanceof WeightSensorDisconnectedError) {
    return { code: 'WEIGHT_SENSOR_ERROR', message: error.message, cause: error };
  }
  if (error instanceof MotorJammedError || error instanceof FeedingTimeoutError || phase === 'motor') {
    return { code: 'MOTOR_ERROR', message: safeHardwareMessage(error, 'Motor failure'), cause: error };
  }
  return {
    code: 'WEIGHT_SENSOR_ERROR',
    message: safeHardwareMessage(error, 'Weight sensor failure'),
    cause: error,
  };
}

function safeHardwareMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.slice(0, 2_000);
  }
  return fallback;
}

function normalizeActualGrams(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError('Weight sensor returned a non-finite value');
  return Math.max(0, Math.round(value * 100) / 100);
}
