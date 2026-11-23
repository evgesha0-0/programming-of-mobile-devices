import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../utils/http-error.js';
import type { ScheduleRepository } from './schedule.repository.js';
import type { DayOfWeek, ScheduleRecord, ScheduleValues } from './schedule.types.js';

export interface ScheduleInput {
  time_local: string;
  days_of_week: DayOfWeek[];
  timezone: string;
  portion_grams: number;
  active: boolean;
}

interface ScheduleItemResponse {
  schedule_id: string;
  time_local: string;
  days_of_week: DayOfWeek[];
  timezone: string;
  portion_grams: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

interface ScheduleResponse extends ScheduleItemResponse {
  device_id: string;
  schedule_revision: number;
}

interface ScheduleListResponse {
  device_id: string;
  schedule_revision: number;
  items: ScheduleItemResponse[];
}

interface DeletedScheduleResponse {
  schedule_id: string;
  deleted: true;
  schedule_revision: number;
  deleted_at: string;
}

interface ScheduleSyncItemResponse {
  schedule_id: string;
  time_local: string;
  days_of_week: DayOfWeek[];
  timezone: string;
  portion_grams: number;
  active: boolean;
  updated_at: string;
  deleted_at: string | null;
}

interface ScheduleSyncResponse {
  device_id: string;
  schedule_revision: number;
  generated_at: string;
  items: ScheduleSyncItemResponse[];
}

export interface ScheduleService {
  list(deviceId: string): Promise<ScheduleListResponse>;
  sync(deviceId: string, knownRevision: number): Promise<ScheduleSyncResponse>;
  create(deviceId: string, input: ScheduleInput): Promise<ScheduleResponse>;
  update(deviceId: string, scheduleId: string, input: ScheduleInput): Promise<ScheduleResponse>;
  delete(deviceId: string, scheduleId: string): Promise<DeletedScheduleResponse>;
}

export function createScheduleService(repository: ScheduleRepository): ScheduleService {
  return {
    async list(deviceId) {
      const result = await repository.list(deviceId);
      if (!result) throw deviceNotFound();
      return {
        device_id: deviceId,
        schedule_revision: toJsonInteger(result.scheduleRevision),
        items: result.items.map(toItemResponse),
      };
    },

    async sync(deviceId, _knownRevision) {
      const result = await repository.sync(deviceId);
      if (!result) throw deviceNotFound();
      return {
        device_id: deviceId,
        schedule_revision: toJsonInteger(result.scheduleRevision),
        generated_at: result.generatedAt.toISOString(),
        items: result.items.map((schedule) => ({
          schedule_id: schedule.scheduleId,
          time_local: schedule.timeLocal,
          days_of_week: schedule.daysOfWeek,
          timezone: schedule.timezone,
          portion_grams: Number(schedule.portionGrams),
          active: schedule.active,
          updated_at: schedule.updatedAt.toISOString(),
          deleted_at: schedule.deletedAt?.toISOString() ?? null,
        })),
      };
    },

    async create(deviceId, input) {
      validateTimezone(input.timezone);
      const schedule = await repository.create(deviceId, randomUUID(), toValues(input));
      if (!schedule) throw deviceNotFound();
      return toScheduleResponse(schedule);
    },

    async update(deviceId, scheduleId, input) {
      validateTimezone(input.timezone);
      const schedule = await repository.update(deviceId, scheduleId, toValues(input));
      if (!schedule) throw scheduleNotFound();
      return toScheduleResponse(schedule);
    },

    async delete(deviceId, scheduleId) {
      const deleted = await repository.delete(deviceId, scheduleId);
      if (!deleted) throw scheduleNotFound();
      return {
        schedule_id: deleted.scheduleId,
        deleted: true,
        schedule_revision: toJsonInteger(deleted.scheduleRevision),
        deleted_at: deleted.deletedAt.toISOString(),
      };
    },
  };
}

function toValues(input: ScheduleInput): ScheduleValues {
  return {
    timeLocal: input.time_local,
    daysOfWeek: input.days_of_week,
    timezone: input.timezone,
    portionGrams: input.portion_grams,
    active: input.active,
  };
}

function toScheduleResponse(schedule: ScheduleRecord): ScheduleResponse {
  return {
    schedule_id: schedule.scheduleId,
    device_id: schedule.deviceId,
    time_local: schedule.timeLocal,
    days_of_week: schedule.daysOfWeek,
    timezone: schedule.timezone,
    portion_grams: Number(schedule.portionGrams),
    active: schedule.active,
    schedule_revision: toJsonInteger(schedule.revision),
    created_at: schedule.createdAt.toISOString(),
    updated_at: schedule.updatedAt.toISOString(),
  };
}

function toItemResponse(schedule: ScheduleRecord): ScheduleItemResponse {
  const { device_id: _deviceId, schedule_revision: _revision, ...item } = toScheduleResponse(schedule);
  return item;
}

function toJsonInteger(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Schedule revision exceeds JSON integer range');
  return number;
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    throw new InvalidTimezoneError();
  }
}

function deviceNotFound(): NotFoundError {
  return new NotFoundError('Устройство не найдено');
}

function scheduleNotFound(): NotFoundError {
  return new NotFoundError('Расписание не найдено');
}

class InvalidTimezoneError extends Error {
  readonly validation = [{ instancePath: '/timezone', message: 'must be a valid IANA timezone' }];

  constructor() {
    super('Поле timezone должно содержать корректный идентификатор IANA timezone');
  }
}

