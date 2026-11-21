import type {
  DayOfWeek,
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

export interface LocalStore {
  close(): void;
  getSchemaVersion(): number;
  getLastHeartbeat(): StoredHeartbeat | null;
  savePendingHeartbeat(payload: ReportDeviceStateRequest): void;
  markHeartbeatDelivered(receipt: HeartbeatDeliveryReceipt): boolean;
  getScheduleSnapshot(): LocalScheduleSnapshot | null;
  replaceScheduleSnapshot(snapshot: LocalScheduleSnapshot): void;
  claimScheduleOccurrence(claim: ScheduleOccurrenceClaim): boolean;
  enqueueOutbox(message: NewOutboxMessage): number;
  listPendingOutbox(limit: number, availableAt: UtcDateTime): OutboxMessage[];
  rescheduleOutbox(id: number, nextAttemptAt: UtcDateTime, lastError: string): boolean;
  markOutboxDelivered(id: number, deliveredAt: UtcDateTime): boolean;
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
