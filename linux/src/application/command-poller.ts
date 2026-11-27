import type { DeviceId } from '../domain/index.js';
import type { JsonLogger } from '../observability/index.js';
import {
  BackendContractError,
  BackendGatewayError,
  type BackendGateway,
  type Clock,
  type LocalStore,
} from '../ports/index.js';

export interface CommandPollerOptions {
  readonly deviceId: DeviceId;
  readonly pollIntervalMs: number;
  readonly gateway: Pick<BackendGateway, 'getPendingCommands'>;
  readonly store: Pick<LocalStore, 'recordManualCommand'>;
  readonly clock: Pick<Clock, 'sleep'>;
  readonly logger: JsonLogger;
}

export class CommandPoller {
  private running = false;

  constructor(private readonly options: CommandPollerOptions) {
    if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 1) {
      throw new RangeError('pollIntervalMs must be a positive safe integer');
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error('CommandPoller is already running');
    this.running = true;
    try {
      while (!signal.aborted) {
        try {
          const { data: { items }, requestId } = await this.options.gateway.getPendingCommands();
          if (signal.aborted) break;
          if (items.some((item) => item.device_id !== this.options.deviceId)) {
            throw new BackendContractError(requestId, new Error('Pending commands include another device'));
          }

          let insertedCount = 0;
          for (const item of items) {
            if (this.options.store.recordManualCommand({
              commandId: item.command_id,
              feedingId: item.feeding_id,
              portionGrams: item.portion_grams,
              createdAt: item.created_at,
              expiresAt: item.expires_at,
            })) {
              insertedCount += 1;
            }
          }
          this.options.logger.debug('pending_commands_polled', {
            itemCount: items.length,
            insertedCount,
            requestId,
          });
        } catch (error) {
          if (signal.aborted) break;
          this.options.logger.error('command_poll_failed', { error });
          if (!(error instanceof BackendGatewayError && error.disposition === 'retryable')) throw error;
        }

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
}
