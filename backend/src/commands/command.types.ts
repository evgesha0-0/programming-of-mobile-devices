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

export type CreateManualCommandResult =
  | { kind: 'created'; command: ManualCommandRecord }
  | { kind: 'repeated'; command: ManualCommandRecord }
  | { kind: 'conflict' }
  | { kind: 'invalid_expiry' }
  | { kind: 'device_not_found' };

