import { utcDateTimeSchema } from '../domain/index.js';
import type { FeedingOrchestrator } from './feeding-orchestrator.js';
import { resolveDueOccurrences, type ScheduledOccurrence } from './schedule-occurrence-resolver.js';
import type { JsonLogger } from '../observability/index.js';
import type {
  Clock,
  IdGenerator,
  LocalSchedule,
  LocalStore,
  Telemetry,
} from '../ports/index.js';

export interface LocalSchedulerOptions {
  readonly store: Pick<LocalStore, 'getScheduleSnapshot' | 'getScheduleOccurrence' | 'claimScheduleOccurrence'>;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly feedingOrchestrator: FeedingOrchestrator;
  readonly telemetry: Telemetry;
  readonly logger: JsonLogger;
  readonly tickIntervalMs: number;
  readonly maximumLatenessMs: number;
}

export interface SchedulerTickResult {
  readonly evaluatedSchedules: number;
  readonly dueOccurrences: number;
  readonly claimedOccurrences: number;
  readonly duplicateOccurrences: number;
  readonly skippedLateOccurrences: number;
  readonly executedFeedings: number;
  readonly queuedEvents: number;
}

export class SchedulerSingleFlightError extends Error {
  constructor() {
    super('LocalScheduler tick is already running');
    this.name = 'SchedulerSingleFlightError';
  }
}

export class LocalScheduler {
  private ticking = false;
  private running = false;

  constructor(private readonly options: LocalSchedulerOptions) {
    assertPositiveSafeInteger(options.tickIntervalMs, 'tickIntervalMs');
    assertPositiveSafeInteger(options.maximumLatenessMs, 'maximumLatenessMs');
  }

  async tick(signal: AbortSignal): Promise<SchedulerTickResult> {
    if (this.ticking) throw new SchedulerSingleFlightError();
    this.ticking = true;
    try {
      const snapshot = this.options.store.getScheduleSnapshot();
      if (!snapshot) return emptyTickResult();
      const now = this.options.clock.now();
      const occurrences = snapshot.items
        .flatMap((schedule) => resolveDueOccurrences(
          schedule,
          now,
          this.options.maximumLatenessMs,
        ))
        .sort(compareOccurrences);

      let claimedOccurrences = 0;
      let duplicateOccurrences = 0;
      let skippedLateOccurrences = 0;
      let executedFeedings = 0;
      for (const occurrence of occurrences) {
        if (signal.aborted) break;
        const currentMs = this.options.clock.now().getTime();
        if (currentMs - Date.parse(occurrence.scheduledFor) > this.options.maximumLatenessMs) {
          skippedLateOccurrences += 1;
          this.options.telemetry.increment('schedule_occurrence_too_late', 1, {
            scheduleId: occurrence.scheduleId,
          });
          continue;
        }
        if (this.options.store.getScheduleOccurrence(occurrence.occurrenceKey)) {
          duplicateOccurrences += 1;
          continue;
        }

        const feedingId = this.options.idGenerator.generateFeedingId();
        const claimedAt = utcDateTimeSchema.parse(new Date(currentMs).toISOString());
        const claimed = this.options.store.claimScheduleOccurrence({
          occurrenceKey: occurrence.occurrenceKey,
          scheduleId: occurrence.scheduleId,
          feedingId,
          scheduledFor: occurrence.scheduledFor,
          claimedAt,
        });
        if (!claimed) {
          duplicateOccurrences += 1;
          continue;
        }
        claimedOccurrences += 1;
        const schedule = findSchedule(snapshot.items, occurrence.scheduleId);
        this.options.telemetry.event('schedule_occurrence_claimed', {
          scheduleId: occurrence.scheduleId,
          feedingId,
          scheduledFor: occurrence.scheduledFor,
        });
        await this.options.feedingOrchestrator.execute({
          feedingId,
          source: 'scheduled',
          commandId: null,
          scheduleId: occurrence.scheduleId,
          portionGrams: schedule.portionGrams,
          createdAt: occurrence.scheduledFor,
        }, signal);
        executedFeedings += 1;
      }

      const result = Object.freeze({
        evaluatedSchedules: snapshot.items.length,
        dueOccurrences: occurrences.length,
        claimedOccurrences,
        duplicateOccurrences,
        skippedLateOccurrences,
        executedFeedings,
        queuedEvents: executedFeedings,
      });
      this.options.logger.info('scheduler_tick_completed', result);
      return result;
    } finally {
      this.ticking = false;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error('LocalScheduler is already running');
    this.running = true;
    try {
      while (!signal.aborted) {
        try {
          await this.tick(signal);
          await this.options.clock.sleep(this.options.tickIntervalMs, signal);
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    } finally {
      this.running = false;
    }
  }
}

function compareOccurrences(left: ScheduledOccurrence, right: ScheduledOccurrence): number {
  return Date.parse(left.scheduledFor) - Date.parse(right.scheduledFor)
    || left.occurrenceKey.localeCompare(right.occurrenceKey);
}

function findSchedule(
  schedules: readonly LocalSchedule[],
  scheduleId: LocalSchedule['scheduleId'],
): LocalSchedule {
  const schedule = schedules.find((candidate) => candidate.scheduleId === scheduleId);
  if (!schedule) throw new Error(`Schedule ${scheduleId} disappeared during scheduler tick`);
  return schedule;
}

function emptyTickResult(): SchedulerTickResult {
  return Object.freeze({
    evaluatedSchedules: 0,
    dueOccurrences: 0,
    claimedOccurrences: 0,
    duplicateOccurrences: 0,
    skippedLateOccurrences: 0,
    executedFeedings: 0,
    queuedEvents: 0,
  });
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
