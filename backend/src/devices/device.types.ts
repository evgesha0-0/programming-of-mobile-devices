export const deviceStatuses = ['online', 'busy', 'error', 'offline', 'unknown'] as const;
export const reportedDeviceStatuses = ['online', 'busy', 'error', 'unknown'] as const;

export type DeviceStatus = (typeof deviceStatuses)[number];
export type ReportedDeviceStatus = (typeof reportedDeviceStatuses)[number];

export interface DeviceStateRecord {
  deviceId: string;
  status: DeviceStatus;
  firmwareVersion: string | null;
  lastSeenAt: Date | null;
  scheduleRevision: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface DeviceStateUpdate {
  status: ReportedDeviceStatus;
  reportedAt: Date;
  firmwareVersion: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface UpdatedDeviceStateRecord extends DeviceStateRecord {
  serverTime: Date;
}

