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

export type ListPendingCommandsResult =
  | { kind: 'found'; commands: PendingCommandListRecord }
  | { kind: 'device_not_found' };

export type CreateManualCommandResult =
  | { kind: 'created'; command: ManualCommandRecord }
  | { kind: 'repeated'; command: ManualCommandRecord }
  | { kind: 'conflict' }
  | { kind: 'invalid_expiry' }
  | { kind: 'device_not_found' };

