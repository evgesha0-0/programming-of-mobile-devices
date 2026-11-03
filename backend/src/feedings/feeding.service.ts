import { ConflictError, NotFoundError } from '../utils/http-error.js';
import type { FeedingRepository } from './feeding.repository.js';
import type { ScheduledFeedingStatus } from './feeding.types.js';

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

export interface FeedingService {
  createScheduledEvent(
    deviceId: string,
    input: ScheduledFeedingInput,
  ): Promise<CreateScheduledFeedingResponse>;
}

export function createFeedingService(repository: FeedingRepository): FeedingService {
  return {
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

class InvalidEventTimelineError extends Error {
  readonly validation = [{ instancePath: '/finished_at', message: 'invalid event timeline' }];

  constructor() {
    super('Временные метки события кормления имеют недопустимую последовательность');
  }
}

