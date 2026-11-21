import { scheduleSyncResponseSchema } from '../contracts/index.js';
import type { DeviceId } from '../domain/index.js';
import type { JsonLogger } from '../observability/index.js';
import {
  BackendGatewayError,
  type BackendGateway,
  type Clock,
  type LocalSchedule,
  type LocalScheduleSnapshot,
  type LocalStore,
} from '../ports/index.js';

export interface ScheduleSyncServiceOptions {
  readonly deviceId: DeviceId;
  readonly syncIntervalMs: number;
  readonly gateway: BackendGateway;
  readonly store: LocalStore;
  readonly clock: Clock;
  readonly logger: JsonLogger;
}

export interface ScheduleSyncResult {
  readonly previousRevision: number;
  readonly revision: number;
  readonly itemCount: number;
  readonly changed: boolean;
  readonly requestId: string | null;
}

export class ScheduleSnapshotValidationError extends Error {
  readonly requestId: string | null;

  constructor(requestId: string | null, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ScheduleSnapshotValidationError';
    this.requestId = requestId;
  }
}

export class ScheduleSyncService {
  private running = false;

  constructor(private readonly options: ScheduleSyncServiceOptions) {
    if (!Number.isSafeInteger(options.syncIntervalMs) || options.syncIntervalMs < 1) {
      throw new RangeError('syncIntervalMs must be a positive safe integer');
    }
  }

  async syncNow(): Promise<ScheduleSyncResult> {
    const current = this.options.store.getScheduleSnapshot();
    const previousRevision = current?.revision ?? 0;
    const response = await this.options.gateway.syncSchedules(previousRevision);
    const snapshot = this.parseCompleteSnapshot(response.data, response.requestId);

    this.options.store.replaceScheduleSnapshot(snapshot);
    const result = Object.freeze({
      previousRevision,
      revision: snapshot.revision,
      itemCount: snapshot.items.length,
      changed: current === null || snapshot.revision !== previousRevision,
      requestId: response.requestId,
    });
    this.options.logger.info('schedule_snapshot_synchronized', result);
    return result;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error('ScheduleSyncService is already running');
    this.running = true;
    try {
      while (!signal.aborted) {
        try {
          await this.syncNow();
        } catch (error) {
          if (signal.aborted) break;
          this.options.logger.error('schedule_sync_failed', { error });
          if (!isRetryableGatewayError(error)) throw error;
        }
        try {
          await this.options.clock.sleep(this.options.syncIntervalMs, signal);
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private parseCompleteSnapshot(
    candidate: unknown,
    requestId: string | null,
  ): LocalScheduleSnapshot {
    let parsed: ReturnType<typeof scheduleSyncResponseSchema.parse>;
    try {
      parsed = scheduleSyncResponseSchema.parse(candidate);
    } catch (error) {
      throw new ScheduleSnapshotValidationError(
        requestId,
        'Schedule snapshot does not match the device contract',
        error,
      );
    }
    if (parsed.device_id !== this.options.deviceId) {
      throw new ScheduleSnapshotValidationError(
        requestId,
        'Schedule snapshot belongs to another device',
      );
    }

    const scheduleIds = new Set<string>();
    const items: LocalSchedule[] = [];
    for (const item of parsed.items) {
      if (scheduleIds.has(item.schedule_id)) {
        throw new ScheduleSnapshotValidationError(
          requestId,
          'Schedule snapshot contains duplicate schedule_id',
        );
      }
      if (item.deleted_at !== null && item.active) {
        throw new ScheduleSnapshotValidationError(
          requestId,
          'Deleted schedule cannot remain active',
        );
      }
      scheduleIds.add(item.schedule_id);
      items.push(Object.freeze({
        scheduleId: item.schedule_id,
        timeLocal: item.time_local,
        daysOfWeek: Object.freeze([...item.days_of_week]),
        timezone: item.timezone,
        portionGrams: item.portion_grams,
        active: item.active,
        updatedAt: item.updated_at,
        deletedAt: item.deleted_at,
      }));
    }

    return Object.freeze({
      revision: parsed.schedule_revision,
      generatedAt: parsed.generated_at,
      items: Object.freeze(items),
    });
  }
}

function isRetryableGatewayError(error: unknown): boolean {
  return error instanceof BackendGatewayError && error.disposition === 'retryable';
}
