import type {
  DayOfWeek,
  CommandId,
  FeedingId,
  ScheduleId,
  UtcDateTime,
} from '../domain/index.js';
import type { ReportDeviceStateRequest } from '../contracts/index.js';

export interface LocalSchedule {
  scheduleId: ScheduleId;
  timeLocal: string;
  daysOfWeek: readonly DayOfWeek[];
  timezone: string;
  portionGrams: number;
  active: boolean;
  updatedAt: UtcDateTime;
  deletedAt: UtcDateTime | null;
}

export interface LocalScheduleSnapshot {
  revision: number;
  generatedAt: UtcDateTime;
  items: readonly LocalSchedule[];
}

export interface ScheduleOccurrenceClaim {
  occurrenceKey: string;
  scheduleId: ScheduleId;
  feedingId: FeedingId;
  scheduledFor: UtcDateTime;
  claimedAt: UtcDateTime;
}

export type OutboxKind = 'state' | 'ack' | 'manual_result' | 'scheduled_event';

export interface NewOutboxMessage {
  kind: OutboxKind;
  aggregateId: string;
  payload: string;
  createdAt: UtcDateTime;
  nextAttemptAt: UtcDateTime;
}

export interface OutboxMessage extends NewOutboxMessage {
  id: number;
  attemptCount: number;
  lastError: string | null;
}

export type HeartbeatDeliveryState = 'pending' | 'delivered';

export interface StoredHeartbeat {
  readonly payload: ReportDeviceStateRequest;
  readonly deliveryState: HeartbeatDeliveryState;
  readonly serverTime: UtcDateTime | null;
  readonly clockOffsetMs: number | null;
  readonly requestId: string | null;
}

export interface HeartbeatDeliveryReceipt {
  readonly reportedAt: UtcDateTime;
  readonly serverTime: UtcDateTime;
  readonly clockOffsetMs: number;
  readonly requestId: string | null;
}

export interface ManualCommand {
  readonly commandId: CommandId;
  readonly feedingId: FeedingId;
  readonly portionGrams: number;
  readonly createdAt: UtcDateTime;
  readonly expiresAt: UtcDateTime;
}

export interface ManualCommandAckIntent extends Pick<ManualCommand, 'commandId' | 'feedingId' | 'expiresAt'> {
  readonly startedAt: UtcDateTime;
}

export interface ManualCommandWork extends Pick<ManualCommand, 'commandId' | 'feedingId'> {
  readonly phase: 'received' | 'ack_intent' | 'acked';
}

interface FeedingIntentBase {
  readonly feedingId: FeedingId;
  readonly portionGrams: number;
  readonly createdAt: UtcDateTime;
}

export interface ManualFeedingIntent extends FeedingIntentBase {
  readonly source: 'manual';
  readonly commandId: CommandId;
  readonly scheduleId: null;
}

export interface ManualFeedingAttempt extends ManualFeedingIntent {
  readonly startedAt: UtcDateTime;
}

export interface ScheduledFeedingIntent extends FeedingIntentBase {
  readonly source: 'scheduled';
  readonly commandId: null;
  readonly scheduleId: ScheduleId;
}

export type FeedingIntent = ManualFeedingIntent | ScheduledFeedingIntent;
export type LocalFeedingStatus = 'pending' | 'running' | 'completed' | 'failed' | 'expired';

export type StoredLocalFeeding = FeedingIntent & Readonly<{
  readonly status: LocalFeedingStatus;
  readonly actualGrams: number | null;
  readonly startedAt: UtcDateTime | null;
  readonly finishedAt: UtcDateTime | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly terminalPayload: string | null;
}>;

interface FeedingCompletionBase {
  readonly feedingId: FeedingId;
  readonly startedAt: UtcDateTime;
  readonly finishedAt: UtcDateTime;
  readonly terminalPayload: string;
}

export interface CompletedFeeding extends FeedingCompletionBase {
  readonly status: 'completed';
  readonly actualGrams: number;
  readonly errorCode: null;
  readonly errorMessage: null;
}

export interface FailedFeeding extends FeedingCompletionBase {
  readonly status: 'failed';
  readonly actualGrams: number | null;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export type FeedingCompletion = CompletedFeeding | FailedFeeding;

export interface LocalStore {
  close(): void;
  getSchemaVersion(): number;
  getLastHeartbeat(): StoredHeartbeat | null;
  savePendingHeartbeat(payload: ReportDeviceStateRequest): void;
  markHeartbeatDelivered(receipt: HeartbeatDeliveryReceipt): boolean;
  getManualCommand(commandId: CommandId): ManualCommand | null;
  getNextManualCommand(serverNow: UtcDateTime): ManualCommand | null;
  recordManualCommand(command: ManualCommand): boolean;
  getNextManualCommandWork(serverNow: UtcDateTime | null): ManualCommandWork | null;
  getNextPendingManualAck(commandId?: CommandId): ManualCommandAckIntent | null;
  recordManualAckIntent(commandId: CommandId, startedAt: UtcDateTime): ManualCommandAckIntent | null;
  resolveManualAck(intent: ManualCommandAckIntent, phase: 'acked' | 'quarantined'): void;
  recordManualActuationIntent(commandId: CommandId, serverNow: UtcDateTime): ManualFeedingAttempt | null;
  getFeeding(feedingId: FeedingId): StoredLocalFeeding | null;
  recordFeedingIntent(intent: FeedingIntent): boolean;
  markFeedingRunning(feedingId: FeedingId, startedAt: UtcDateTime): boolean;
  completeFeedingAndEnqueue(completion: FeedingCompletion, outbox: NewOutboxMessage): number;
  getScheduleSnapshot(): LocalScheduleSnapshot | null;
  replaceScheduleSnapshot(snapshot: LocalScheduleSnapshot): void;
  getScheduleOccurrence(occurrenceKey: string): ScheduleOccurrenceClaim | null;
  claimScheduleOccurrence(claim: ScheduleOccurrenceClaim): boolean;
  enqueueOutbox(message: NewOutboxMessage): number;
  listPendingOutbox(limit: number, availableAt: UtcDateTime): OutboxMessage[];
  rescheduleOutbox(id: number, nextAttemptAt: UtcDateTime, lastError: string): boolean;
  markOutboxDelivered(id: number, deliveredAt: UtcDateTime): boolean;
}

export class ManualCommandConflictError extends Error {
  constructor(commandId: CommandId) {
    super(`Manual command ${commandId} has conflicting content or feeding identity`);
    this.name = 'ManualCommandConflictError';
  }
}

export class FeedingIntentConflictError extends Error {
  constructor(feedingId: FeedingId) {
    super(`Feeding intent ${feedingId} has conflicting content`);
    this.name = 'FeedingIntentConflictError';
  }
}

export class FeedingStateConflictError extends Error {
  constructor(feedingId: FeedingId) {
    super(`Feeding ${feedingId} is not in the required execution state`);
    this.name = 'FeedingStateConflictError';
  }
}

export class NonMonotonicHeartbeatError extends Error {
  constructor() {
    super('Heartbeat reported_at must be newer than the stored heartbeat');
    this.name = 'NonMonotonicHeartbeatError';
  }
}

export class HeartbeatPayloadConflictError extends Error {
  constructor() {
    super('Heartbeat reported_at is already stored with different content');
    this.name = 'HeartbeatPayloadConflictError';
  }
}

export class LocalStoreLockedError extends Error {
  constructor(path: string) {
    super(`Local store is already locked: ${path}`);
    this.name = 'LocalStoreLockedError';
  }
}

export class StaleScheduleRevisionError extends Error {
  constructor(received: number, current: number) {
    super(`Schedule revision ${received} is older than local revision ${current}`);
    this.name = 'StaleScheduleRevisionError';
  }
}

export class ScheduleRevisionConflictError extends Error {
  constructor(revision: number) {
    super(`Schedule revision ${revision} has conflicting content`);
    this.name = 'ScheduleRevisionConflictError';
  }
}

export class ScheduleOccurrenceConflictError extends Error {
  constructor(identifier: string) {
    super(`Schedule occurrence has conflicting identity: ${identifier}`);
    this.name = 'ScheduleOccurrenceConflictError';
  }
}

export class OutboxConflictError extends Error {
  constructor(kind: OutboxKind, aggregateId: string) {
    super(`Outbox message ${kind}/${aggregateId} has conflicting content`);
    this.name = 'OutboxConflictError';
  }
}
