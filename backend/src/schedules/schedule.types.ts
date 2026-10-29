export const daysOfWeek = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export type DayOfWeek = (typeof daysOfWeek)[number];

export interface ScheduleRecord {
  scheduleId: string;
  deviceId: string;
  timeLocal: string;
  daysOfWeek: DayOfWeek[];
  timezone: string;
  portionGrams: string;
  active: boolean;
  revision: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ScheduleValues {
  timeLocal: string;
  daysOfWeek: DayOfWeek[];
  timezone: string;
  portionGrams: number;
  active: boolean;
}

export interface ScheduleListRecord {
  scheduleRevision: string;
  items: ScheduleRecord[];
}

export interface ScheduleSyncRecord extends ScheduleListRecord {
  generatedAt: Date;
}

export interface DeletedScheduleRecord {
  scheduleId: string;
  scheduleRevision: string;
  deletedAt: Date;
}

