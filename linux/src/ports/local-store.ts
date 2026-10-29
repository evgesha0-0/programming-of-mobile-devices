import type {
  DayOfWeek,
  FeedingId,
  ScheduleId,
  UtcDateTime,
} from '../domain/index.js';

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

export interface LocalStore {
  close(): void;
  getSchemaVersion(): number;
  getScheduleSnapshot(): LocalScheduleSnapshot | null;
  replaceScheduleSnapshot(snapshot: LocalScheduleSnapshot): void;
  claimScheduleOccurrence(claim: ScheduleOccurrenceClaim): boolean;
  enqueueOutbox(message: NewOutboxMessage): number;
  listPendingOutbox(limit: number, availableAt: UtcDateTime): OutboxMessage[];
  rescheduleOutbox(id: number, nextAttemptAt: UtcDateTime, lastError: string): boolean;
  markOutboxDelivered(id: number, deliveredAt: UtcDateTime): boolean;
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
