import type { AcknowledgeCommandResponse } from '../contracts/index.js';
import type { CommandId } from '../domain/index.js';
import type {
  BackendGateway,
  BackendGatewayResult,
  Clock,
  LocalStore,
  ManualCommand,
} from '../ports/index.js';

export interface ManualCommandQueueOptions {
  readonly store: Pick<LocalStore, 'getLastHeartbeat' | 'getManualCommand' | 'getNextManualCommand'>;
  readonly gateway: Pick<BackendGateway, 'acknowledgeCommand'>;
  readonly clock: Pick<Clock, 'now'>;
  readonly maxClockSkewMs: number;
}

export class ManualCommandQueue {
  constructor(private readonly options: ManualCommandQueueOptions) {}

  getNext(): ManualCommand | null {
    const serverNow = this.readServerNow();
    return serverNow === null ? null : this.options.store.getNextManualCommand(serverNow.toISOString());
  }

  // Replays must use their original acknowledgement, not a new started_at.
  async acknowledgeFirst(
    commandId: CommandId,
  ): Promise<BackendGatewayResult<AcknowledgeCommandResponse> | null> {
    const command = this.options.store.getManualCommand(commandId);
    if (!command) return null;

    const serverNow = this.readServerNow();
    if (serverNow === null || Date.parse(command.expiresAt) <= serverNow.getTime()) return null;

    return this.options.gateway.acknowledgeCommand(commandId, {
      feeding_id: command.feedingId,
      status: 'running',
      started_at: serverNow.toISOString(),
    });
  }

  private readServerNow(): Date | null {
    const heartbeat = this.options.store.getLastHeartbeat();
    if (
      heartbeat?.deliveryState !== 'delivered'
      || heartbeat.clockOffsetMs === null
      || Math.abs(heartbeat.clockOffsetMs) > this.options.maxClockSkewMs
    ) {
      return null;
    }

    const serverNow = new Date(this.options.clock.now().getTime() + heartbeat.clockOffsetMs);
    if (!Number.isFinite(serverNow.getTime())) throw new Error('Clock returned an invalid date');
    return serverNow;
  }
}
