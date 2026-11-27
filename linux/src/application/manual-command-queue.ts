import type { AcknowledgeCommandResponse } from '../contracts/index.js';
import type { CommandId } from '../domain/index.js';
import {
  BackendContractError,
  BackendGatewayError,
  type BackendGateway,
  type BackendGatewayResult,
  type Clock,
  type LocalStore,
  type ManualCommand,
  type ManualCommandAckIntent,
} from '../ports/index.js';

export interface ManualCommandQueueOptions {
  readonly store: Pick<LocalStore,
    'getLastHeartbeat' | 'getNextManualCommand' | 'getNextPendingManualAck'
    | 'recordManualAckIntent' | 'resolveManualAck'
  >;
  readonly gateway: Pick<BackendGateway, 'acknowledgeCommand'>;
  readonly clock: Pick<Clock, 'now'>;
  readonly maxClockSkewMs: number;
}

export class ManualCommandQueue {
  private acknowledging = false;

  constructor(private readonly options: ManualCommandQueueOptions) {}

  getNext(): ManualCommand | null {
    const serverNow = this.readServerNow();
    return serverNow === null ? null : this.options.store.getNextManualCommand(serverNow.toISOString());
  }

  async acknowledgeFirst(
    commandId: CommandId,
  ): Promise<BackendGatewayResult<AcknowledgeCommandResponse> | null> {
    if (this.acknowledging) return null;
    const serverNow = this.readServerNow();
    if (serverNow === null) return null;

    const intent = this.options.store.recordManualAckIntent(commandId, serverNow.toISOString());
    if (intent === null) return null;

    // The durable write can cross the deadline before any request has been sent.
    const sendTime = this.readServerNow();
    if (sendTime === null || Date.parse(intent.expiresAt) <= sendTime.getTime()) {
      this.options.store.resolveManualAck(intent, 'quarantined');
      return null;
    }
    return this.sendAck(intent);
  }

  async retryPendingAck(): Promise<BackendGatewayResult<AcknowledgeCommandResponse> | null> {
    if (this.acknowledging) return null;
    // A committed intent may already have been accepted, regardless of the deadline.
    const intent = this.options.store.getNextPendingManualAck();
    return intent === null ? null : this.sendAck(intent);
  }

  private async sendAck(intent: ManualCommandAckIntent): Promise<BackendGatewayResult<AcknowledgeCommandResponse>> {
    this.acknowledging = true;
    try {
      const response = await this.options.gateway.acknowledgeCommand(intent.commandId, {
        feeding_id: intent.feedingId,
        status: 'running',
        started_at: intent.startedAt,
      });
      if (
        response.data.command_id !== intent.commandId
        || response.data.feeding_id !== intent.feedingId
        || response.data.status !== 'running'
        || Date.parse(response.data.started_at) !== Date.parse(intent.startedAt)
      ) {
        throw new BackendContractError(response.requestId);
      }
      this.options.store.resolveManualAck(intent, 'acked');
      return response;
    } catch (error) {
      if (
        error instanceof BackendGatewayError
        && (error.disposition === 'quarantine' || error.statusCode === 400 || error.statusCode === 404)
      ) {
        this.options.store.resolveManualAck(intent, 'quarantined');
      }
      throw error;
    } finally {
      this.acknowledging = false;
    }
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
