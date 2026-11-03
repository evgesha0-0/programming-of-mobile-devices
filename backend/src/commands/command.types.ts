export type FeedingStatus = 'pending' | 'running' | 'completed' | 'failed' | 'expired';

export interface ManualCommandRecord {
  commandId: string;
  feedingId: string;
  deviceId: string;
  portionGrams: string;
  status: FeedingStatus;
  createdAt: Date;
  expiresAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  actualGrams: string | null;
  errorCode: string | null;
}

export interface ManualCommandValues {
  commandId: string;
  feedingId: string;
  deviceId: string;
  portionGrams: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface PendingCommandRecord {
  commandId: string;
  feedingId: string;
  deviceId: string;
  portionGrams: string;
  status: 'pending';
  createdAt: Date;
  expiresAt: Date;
}

export interface PendingCommandListRecord {
  serverTime: Date;
  items: PendingCommandRecord[];
}

export interface AcknowledgeCommandValues {
  deviceId: string;
  commandId: string;
  feedingId: string;
  startedAt: Date;
}

export interface AcknowledgedCommandRecord {
  commandId: string;
  feedingId: string;
  status: 'running';
  startedAt: Date;
}

export type AcknowledgeCommandResult =
  | { kind: 'acknowledged'; command: AcknowledgedCommandRecord }
  | { kind: 'not_found' }
  | { kind: 'conflict' }
  | { kind: 'invalid_started_at' };

export type ManualResultStatus = 'completed' | 'failed';

export interface ManualFeedingResultValues {
  deviceId: string;
  feedingId: string;
  commandId: string;
  source: 'manual';
  portionGrams: number;
  actualGrams: number | null;
  status: ManualResultStatus;
  startedAt: Date;
  finishedAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ManualFeedingResultRecord {
  feedingId: string;
  commandId: string;
  status: ManualResultStatus;
  actualGrams: string | null;
  finishedAt: Date;
}

export type SubmitManualFeedingResult =
  | { kind: 'accepted'; result: ManualFeedingResultRecord }
  | { kind: 'not_found' }
  | { kind: 'conflict' }
  | { kind: 'invalid_timeline' };

export type ListPendingCommandsResult =
  | { kind: 'found'; commands: PendingCommandListRecord }
  | { kind: 'device_not_found' };

export type CreateManualCommandResult =
  | { kind: 'created'; command: ManualCommandRecord }
  | { kind: 'repeated'; command: ManualCommandRecord }
  | { kind: 'conflict' }
  | { kind: 'invalid_expiry' }
  | { kind: 'device_not_found' };

