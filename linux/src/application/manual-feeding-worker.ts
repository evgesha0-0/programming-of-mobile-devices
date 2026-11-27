import { manualFeedingResultRequestSchema } from '../contracts/index.js';
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
  readonly store: Pick<LocalStore, 'markOutboxDelivered'>;
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
    let execution: FeedingExecutionResult | null;
    try {
      execution = await this.options.feedingOrchestrator.executeNextManual(this.options.queue, signal);
    } catch (error) {
      if (signal.aborted) return null;
      if (!isManualAckRefusal(error) && !isRetryableGatewayError(error)) throw error;
      this.options.logger.warn('manual_command_ack_not_confirmed', { error });
      return null;
    }
    if (execution === null || signal.aborted) return execution;

    const payload = manualFeedingResultRequestSchema.parse(JSON.parse(execution.terminalPayload) as unknown);
    try {
      const { data, requestId } = await this.options.gateway.reportManualFeedingResult(execution.feedingId, payload);
      if (
        data.feeding_id !== execution.feedingId
        || data.command_id !== payload.command_id
        || data.status !== payload.status
        || data.actual_grams !== payload.actual_grams
        || Date.parse(data.finished_at) !== Date.parse(payload.finished_at)
      ) {
        throw new BackendContractError(requestId);
      }
      if (!this.options.store.markOutboxDelivered(execution.outboxId, this.options.clock.now().toISOString())) {
        throw new Error('Manual feeding result outbox could not be marked delivered');
      }
    } catch (error) {
      if (signal.aborted) return execution;
      if (!isRetryableGatewayError(error)) throw error;
      this.options.logger.warn('manual_feeding_result_queued_for_retry', { feedingId: execution.feedingId });
    }
    return execution;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error('ManualFeedingWorker is already running');
    this.running = true;
    try {
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
