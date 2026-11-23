import { ConflictError, NotFoundError } from '../utils/http-error.js';
import type { FeedingRepository } from './feeding.repository.js';
import type {
  FeedingHistoryCursor,
  FeedingHistoryItemRecord,
  FeedingSource,
  FeedingStatus,
  ScheduledFeedingStatus,
} from './feeding.types.js';

interface ScheduledFeedingBaseInput {
  feeding_id: string;
  schedule_id: string;
  source: 'scheduled';
  portion_grams: number;
  created_at: string;
  started_at: string;
  finished_at: string;
}

export interface CompletedScheduledFeedingInput extends ScheduledFeedingBaseInput {
  actual_grams: number;
  status: 'completed';
  error_code: null;
  error_message: null;
}

export interface FailedScheduledFeedingInput extends ScheduledFeedingBaseInput {
  actual_grams: number | null;
  status: 'failed';
  error_code: string;
  error_message: string;
}

export type ScheduledFeedingInput =
  | CompletedScheduledFeedingInput
  | FailedScheduledFeedingInput;

export interface ScheduledFeedingResponse {
  feeding_id: string;
  device_id: string;
  schedule_id: string;
  source: 'scheduled';
  status: ScheduledFeedingStatus;
  actual_grams: number | null;
  received_at: string;
}

export interface CreateScheduledFeedingResponse {
  created: boolean;
  event: ScheduledFeedingResponse;
}

export interface FeedingHistoryItemResponse {
  feeding_id: string;
  device_id: string;
  schedule_id: string | null;
  command_id: string | null;
  source: FeedingSource;
  portion_grams: number;
  actual_grams: number | null;
  status: FeedingStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
}

export interface FeedingHistoryResponse {
  items: FeedingHistoryItemResponse[];
  next_cursor: string | null;
}

export interface FeedingDetailsResponse extends FeedingHistoryItemResponse {
  error_message: string | null;
}

export interface FeedingService {
  getDetails(deviceId: string, feedingId: string): Promise<FeedingDetailsResponse>;
  listHistory(
    deviceId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<FeedingHistoryResponse>;
  createScheduledEvent(
    deviceId: string,
    input: ScheduledFeedingInput,
  ): Promise<CreateScheduledFeedingResponse>;
}

export function createFeedingService(repository: FeedingRepository): FeedingService {
  return {
    async getDetails(deviceId, feedingId) {
      const result = await repository.find(deviceId, feedingId);
      if (!result) throw new NotFoundError('Кормление не найдено');
      return {
        ...toHistoryItemResponse(result),
        error_message: result.errorMessage,
      };
    },
    async listHistory(deviceId, limit, cursorValue) {
      const cursor = cursorValue === undefined ? null : decodeCursor(cursorValue, deviceId);
      const result = await repository.list(deviceId, limit, cursor);
      if (!result) throw new NotFoundError('Устройство не найдено');
      return {
        items: result.items.map(toHistoryItemResponse),
        next_cursor: result.nextCursor === null
          ? null
          : encodeCursor(result.nextCursor, deviceId),
      };
    },
    async createScheduledEvent(deviceId, input) {
      const result = await repository.createScheduledEvent({
        feedingId: input.feeding_id,
        deviceId,
        scheduleId: input.schedule_id,
        source: input.source,
        portionGrams: input.portion_grams,
        actualGrams: input.actual_grams,
        status: input.status,
        createdAt: new Date(input.created_at),
        startedAt: new Date(input.started_at),
        finishedAt: new Date(input.finished_at),
        errorCode: input.error_code,
        errorMessage: input.error_message,
      });
      if (result.kind === 'not_found') {
        throw new NotFoundError('Устройство или расписание не найдено');
      }
      if (result.kind === 'conflict') {
        throw new ConflictError('feeding_id уже используется для другого события');
      }
      if (result.kind === 'invalid_timeline') throw new InvalidEventTimelineError();
      return {
        created: result.kind === 'created',
        event: {
          feeding_id: result.event.feedingId,
          device_id: result.event.deviceId,
          schedule_id: result.event.scheduleId,
          source: result.event.source,
          status: result.event.status,
          actual_grams: result.event.actualGrams === null
            ? null
            : Number(result.event.actualGrams),
          received_at: result.event.receivedAt.toISOString(),
        },
      };
    },
  };
}

function toHistoryItemResponse(item: FeedingHistoryItemRecord): FeedingHistoryItemResponse {
  return {
    feeding_id: item.feedingId,
    device_id: item.deviceId,
    schedule_id: item.scheduleId,
    command_id: item.commandId,
    source: item.source,
    portion_grams: Number(item.portionGrams),
    actual_grams: item.actualGrams === null ? null : Number(item.actualGrams),
    status: item.status,
    created_at: item.createdAt.toISOString(),
    started_at: item.startedAt?.toISOString() ?? null,
    finished_at: item.finishedAt?.toISOString() ?? null,
    error_code: item.errorCode,
  };
}

function encodeCursor(cursor: FeedingHistoryCursor, deviceId: string): string {
  return Buffer.from(JSON.stringify({
    device_id: deviceId,
    created_at: cursor.createdAt,
    feeding_id: cursor.feedingId,
  }), 'utf8').toString('base64url');
}

function decodeCursor(value: string, deviceId: string): FeedingHistoryCursor {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) throw new Error();
    const parsed: unknown = JSON.parse(decoded);
    if (!isCursorPayload(parsed)) throw new Error();
    if (parsed.device_id !== deviceId) throw new Error();
    if (!Number.isFinite(Date.parse(parsed.created_at))) throw new Error();
    return { createdAt: parsed.created_at, feedingId: parsed.feeding_id };
  } catch {
    throw new InvalidCursorError();
  }
}

function isCursorPayload(
  value: unknown,
): value is { device_id: string; created_at: string; feeding_id: string } {
  if (typeof value !== 'object' || value === null) return false;
  const entries = Object.entries(value);
  if (entries.length !== 3) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.device_id === 'string'
    && typeof payload.created_at === 'string'
    && typeof payload.feeding_id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.feeding_id,
    );
}

class InvalidEventTimelineError extends Error {
  readonly validation = [{ instancePath: '/finished_at', message: 'invalid event timeline' }];

  constructor() {
    super('Временные метки события кормления имеют недопустимую последовательность');
  }
}

class InvalidCursorError extends Error {
  readonly validation = [{ instancePath: '/cursor', message: 'invalid cursor' }];

  constructor() {
    super('Некорректный курсор истории кормлений');
  }
}

