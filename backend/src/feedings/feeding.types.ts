export type ScheduledFeedingStatus = 'completed' | 'failed';

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

