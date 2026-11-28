import { ZodError } from 'zod';

import { manualFeedingResultRequestSchema, scheduledFeedingEventRequestSchema } from '../contracts/index.js';
import { feedingIdSchema, type DeviceId } from '../domain/index.js';
import type { JsonLogger } from '../observability/index.js';
import {
  BackendContractError,
  BackendGatewayError,
  isPermanentOutboxDeliveryError,
  type BackendGateway,
  type Clock,
  type LocalStore,
  type OutboxMessage,
} from '../ports/index.js';

const deliveryKinds = ['manual_result', 'scheduled_event'] as const;
const batchSize = 32;

export interface OutboxDeliveryServiceOptions {
  readonly deviceId: DeviceId;
  readonly store: Pick<LocalStore, 'listPendingOutbox' | 'markOutboxDelivered' | 'markOutboxFailed' | 'rescheduleOutbox'>;
  readonly gateway: Pick<BackendGateway, 'reportManualFeedingResult' | 'reportScheduledFeedingEvent'>;
  readonly clock: Clock;
  readonly logger: JsonLogger;
  readonly pollIntervalMs: number;
  readonly backoffInitialMs: number;
  readonly backoffMaxMs: number;
}

export class OutboxDeliveryService {
  private running = false;
  private ticking = false;

  constructor(private readonly options: OutboxDeliveryServiceOptions) {
    const { pollIntervalMs, backoffInitialMs, backoffMaxMs } = options;
    if (
      ![pollIntervalMs, backoffInitialMs, backoffMaxMs].every((ms) => Number.isSafeInteger(ms) && ms > 0)
      || backoffInitialMs > backoffMaxMs
    ) {
      throw new RangeError('Invalid outbox polling interval or retry backoff');
    }
  }

  async tick(signal: AbortSignal): Promise<void> {
    if (this.ticking) throw new Error('OutboxDeliveryService tick is already running');
    if (signal.aborted) return;
    this.ticking = true;
    try {
      const pending = this.options.store.listPendingOutbox(batchSize, this.options.clock.now().toISOString(), deliveryKinds);
      for (const message of pending) {
        if (signal.aborted) return;
        try {
          await this.send(message);
        } catch (error) {
          if (signal.aborted) return;
          this.handleFailure(message, error);
          continue;
        }
        if (!this.options.store.markOutboxDelivered(message.id, this.options.clock.now().toISOString())) {
          throw new Error(`Outbox message ${message.id} could not be marked delivered`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error('OutboxDeliveryService is already running');
    this.running = true;
    try {
      while (!signal.aborted) {
        await this.tick(signal);
        try {
          await this.options.clock.sleep(this.options.pollIntervalMs, signal);
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async send(message: OutboxMessage): Promise<void> {
    const feedingId = feedingIdSchema.parse(message.aggregateId);
    const payload: unknown = JSON.parse(message.payload);
    if (message.kind === 'manual_result') {
      const result = manualFeedingResultRequestSchema.parse(payload);
      const { data, requestId } = await this.options.gateway.reportManualFeedingResult(feedingId, message.payload);
      if (
        data.feeding_id !== feedingId || data.command_id !== result.command_id
        || data.status !== result.status || data.actual_grams !== result.actual_grams
        || Date.parse(data.finished_at) !== Date.parse(result.finished_at)
      ) {
        throw new BackendContractError(requestId);
      }
    } else if (message.kind === 'scheduled_event') {
      const event = scheduledFeedingEventRequestSchema.parse(payload);
      if (event.feeding_id !== feedingId) throw new SyntaxError('Outbox feeding ID does not match the scheduled event');
      const { data, requestId } = await this.options.gateway.reportScheduledFeedingEvent(message.payload);
      if (
        data.feeding_id !== feedingId || data.device_id !== this.options.deviceId || data.schedule_id !== event.schedule_id
        || data.source !== event.source || data.status !== event.status || data.actual_grams !== event.actual_grams
      ) {
        throw new BackendContractError(requestId);
      }
    } else {
      throw new Error(`Unexpected outbox delivery kind: ${message.kind}`);
    }
  }

  private handleFailure(message: OutboxMessage, error: unknown): void {
    const context = { outboxId: message.id, kind: message.kind };
    if (error instanceof BackendGatewayError) {
      if (error.statusCode === 401 || error.statusCode === 403) {
        this.options.logger.error('outbox_delivery_access_denied', { ...context, statusCode: error.statusCode });
        throw error;
      }
      if (error.disposition === 'retryable') {
        const delayMs = Math.min(this.options.backoffInitialMs * 2 ** message.attemptCount, this.options.backoffMaxMs);
        const nextAttemptAt = new Date(this.options.clock.now().getTime() + delayMs).toISOString();
        if (!this.options.store.rescheduleOutbox(message.id, nextAttemptAt, error.message)) {
          throw new Error(`Outbox message ${message.id} could not be scheduled for retry`);
        }
        this.options.logger.warn('outbox_delivery_retry_scheduled', { ...context, nextAttemptAt, statusCode: error.statusCode });
        return;
      }
    }

    let lastError: string;
    if (isPermanentOutboxDeliveryError(error)) {
      lastError = error.message;
    } else if (error instanceof SyntaxError || error instanceof ZodError) {
      lastError = 'Stored outbox payload does not match the device contract';
    } else {
      throw error;
    }
    if (!this.options.store.markOutboxFailed(message.id, this.options.clock.now().toISOString(), lastError)) {
      throw new Error(`Outbox message ${message.id} could not be marked failed`);
    }
    this.options.logger.warn('outbox_delivery_failed', { ...context, lastError });
  }
}
