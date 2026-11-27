import { manualFeedingResultRequestSchema } from '../contracts/index.js';
import { feedingIdSchema } from '../domain/index.js';
import type { JsonLogger } from '../observability/index.js';
import {
  BackendContractError,
  BackendGatewayError,
  type BackendGateway,
  type Clock,
  type LocalStore,
} from '../ports/index.js';
import type { FeedingExecutionResult, FeedingOrchestrator } from './feeding-orchestrator.js';
import { isManualAckRefusal, type ManualCommandQueue } from './manual-command-queue.js';

export interface ManualFeedingWorkerOptions {
  readonly queue: ManualCommandQueue;
  readonly feedingOrchestrator: FeedingOrchestrator;
  readonly store: Pick<LocalStore,
    'completeFeedingAndEnqueue' | 'listInterruptedManualFeedings' | 'listPendingOutbox'
    | 'markOutboxDelivered' | 'rescheduleOutbox'
  >;
  readonly gateway: Pick<BackendGateway, 'reportManualFeedingResult'>;
  readonly clock: Clock;
  readonly logger: JsonLogger;
  readonly intervalMs: number;
}

export class ManualFeedingWorker {
  private running = false;

  constructor(private readonly options: ManualFeedingWorkerOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new RangeError('intervalMs must be a positive safe integer');
    }
  }

  async tick(signal: AbortSignal): Promise<FeedingExecutionResult | null> {
    await this.deliverPendingResults(signal);
    if (signal.aborted) return null;

    let execution: FeedingExecutionResult | null;
    try {
      execution = await this.options.feedingOrchestrator.executeNextManual(this.options.queue, signal);
    } catch (error) {
      if (signal.aborted) return null;
      if (!isManualAckRefusal(error) && !isRetryableGatewayError(error)) throw error;
      this.options.logger.warn('manual_command_ack_not_confirmed', { error });
      return null;
    }
    if (execution !== null) await this.deliverPendingResults(signal);
    return execution;
  }

  private async deliverPendingResults(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const pending = this.options.store.listPendingOutbox(32, this.options.clock.now().toISOString(), 'manual_result');
    for (const message of pending) {
      if (signal.aborted) return;
      const feedingId = feedingIdSchema.parse(message.aggregateId);
      const payload = manualFeedingResultRequestSchema.parse(JSON.parse(message.payload) as unknown);
      try {
        const { data, requestId } = await this.options.gateway.reportManualFeedingResult(feedingId, payload);
        if (
          data.feeding_id !== feedingId
          || data.command_id !== payload.command_id
          || data.status !== payload.status
          || data.actual_grams !== payload.actual_grams
          || Date.parse(data.finished_at) !== Date.parse(payload.finished_at)
        ) {
          throw new BackendContractError(requestId);
        }
        if (!this.options.store.markOutboxDelivered(message.id, this.options.clock.now().toISOString())) {
          throw new Error('Manual feeding result outbox could not be marked delivered');
        }
      } catch (error) {
        if (signal.aborted) return;
        if (!isRetryableGatewayError(error)) throw error;
        const nextAttemptAt = new Date(this.options.clock.now().getTime() + this.options.intervalMs).toISOString();
        if (!this.options.store.rescheduleOutbox(message.id, nextAttemptAt, 'Manual result delivery was not confirmed')) {
          throw new Error('Manual feeding result retry could not be scheduled');
        }
        this.options.logger.warn('manual_feeding_result_queued_for_retry', { feedingId, nextAttemptAt });
      }
    }
  }

  private recoverInterruptedFeedings(): void {
    const attempts = this.options.store.listInterruptedManualFeedings();
    if (attempts.length === 0) return;
    const now = this.options.clock.now();
    const recoveredAtMs = (this.options.queue.readServerNow() ?? now).getTime();
    const errorCode = 'INTERNAL_ERROR';
    const errorMessage = 'Feeding was interrupted by a restart; dispensed weight is unknown';

    for (const attempt of attempts) {
      const finishedAt = new Date(Math.max(recoveredAtMs, Date.parse(attempt.startedAt))).toISOString();
      const payload = JSON.stringify(manualFeedingResultRequestSchema.parse({
        command_id: attempt.commandId,
        source: 'manual',
        portion_grams: attempt.portionGrams,
        actual_grams: null,
        status: 'failed',
        started_at: attempt.startedAt,
        finished_at: finishedAt,
        error_code: errorCode,
        error_message: errorMessage,
      }));
      this.options.store.completeFeedingAndEnqueue({
        feedingId: attempt.feedingId,
        status: 'failed',
        startedAt: attempt.startedAt,
        finishedAt,
        actualGrams: null,
        errorCode,
        errorMessage,
        terminalPayload: payload,
      }, {
        kind: 'manual_result',
        aggregateId: attempt.feedingId,
        payload,
        createdAt: finishedAt,
        nextAttemptAt: now.toISOString(),
      });
      this.options.logger.warn('manual_feeding_interrupted', {
        commandId: attempt.commandId,
        feedingId: attempt.feedingId,
      });
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error('ManualFeedingWorker is already running');
    this.running = true;
    try {
      if (!signal.aborted) this.recoverInterruptedFeedings();
      while (!signal.aborted) {
        await this.tick(signal);
        try {
          await this.options.clock.sleep(this.options.intervalMs, signal);
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    } finally {
      this.running = false;
    }
  }
}

function isRetryableGatewayError(error: unknown): boolean {
  return error instanceof BackendGatewayError && error.disposition === 'retryable';
}
