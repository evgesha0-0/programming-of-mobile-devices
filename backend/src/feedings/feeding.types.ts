export type ScheduledFeedingStatus = 'completed' | 'failed';
export type FeedingStatus = 'pending' | 'running' | ScheduledFeedingStatus | 'expired';
export type FeedingSource = 'manual' | 'scheduled';

export interface ScheduledFeedingEventValues {
  feedingId: string;
  deviceId: string;
  scheduleId: string;
  source: 'scheduled';
  portionGrams: number;
  actualGrams: number | null;
  status: ScheduledFeedingStatus;
  createdAt: Date;
  startedAt: Date;
  finishedAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ScheduledFeedingEventRecord {
  feedingId: string;
  deviceId: string;
  scheduleId: string;
  source: 'scheduled';
  status: ScheduledFeedingStatus;
  actualGrams: string | null;
  receivedAt: Date;
}

export type CreateScheduledFeedingEventResult =
  | { kind: 'created'; event: ScheduledFeedingEventRecord }
  | { kind: 'repeated'; event: ScheduledFeedingEventRecord }
  | { kind: 'not_found' }
  | { kind: 'conflict' }
  | { kind: 'invalid_timeline' };

export interface FeedingHistoryCursor {
  createdAt: string;
  feedingId: string;
}

export interface FeedingHistoryItemRecord {
  feedingId: string;
  deviceId: string;
  scheduleId: string | null;
  commandId: string | null;
  source: FeedingSource;
  portionGrams: string;
  actualGrams: string | null;
  status: FeedingStatus;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
}

export interface FeedingDetailsRecord extends FeedingHistoryItemRecord {
  errorMessage: string | null;
}

export interface FeedingHistoryPageRecord {
  items: FeedingHistoryItemRecord[];
  nextCursor: FeedingHistoryCursor | null;
}

