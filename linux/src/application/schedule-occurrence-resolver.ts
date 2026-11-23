import { Temporal } from '@js-temporal/polyfill';

import { utcDateTimeSchema, type DayOfWeek } from '../domain/index.js';
import type { LocalSchedule } from '../ports/index.js';

const temporalDayNames: Readonly<Record<number, DayOfWeek>> = Object.freeze({
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
  7: 'sun',
});

export interface ScheduledOccurrence {
  readonly occurrenceKey: string;
  readonly scheduleId: LocalSchedule['scheduleId'];
  readonly scheduledFor: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timezone: string;
}

export function resolveDueOccurrences(
  schedule: LocalSchedule,
  now: Date,
  maximumLatenessMs: number,
): ScheduledOccurrence[] {
  if (!Number.isSafeInteger(maximumLatenessMs) || maximumLatenessMs < 0) {
    throw new RangeError('maximumLatenessMs must be a nonnegative safe integer');
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError('now must be a valid Date');
  if (!schedule.active || schedule.deletedAt !== null) return [];

  const nowInstant = Temporal.Instant.fromEpochMilliseconds(nowMs);
  const earliestInstant = Temporal.Instant.fromEpochMilliseconds(nowMs - maximumLatenessMs);
  const firstDate = earliestInstant.toZonedDateTimeISO(schedule.timezone).toPlainDate();
  const lastDate = nowInstant.toZonedDateTimeISO(schedule.timezone).toPlainDate();
  const localTime = Temporal.PlainTime.from(schedule.timeLocal);
  const occurrences: ScheduledOccurrence[] = [];

  for (
    let date = firstDate;
    Temporal.PlainDate.compare(date, lastDate) <= 0;
    date = date.add({ days: 1 })
  ) {
    const day = temporalDayNames[date.dayOfWeek];
    if (!day || !schedule.daysOfWeek.includes(day)) continue;
    const plainDateTime = date.toPlainDateTime(localTime);
    const earlier = plainDateTime.toZonedDateTime(schedule.timezone, {
      disambiguation: 'earlier',
    });
    const later = plainDateTime.toZonedDateTime(schedule.timezone, {
      disambiguation: 'later',
    });
    const earlierMatches = earlier.toPlainDateTime().equals(plainDateTime);
    const laterMatches = later.toPlainDateTime().equals(plainDateTime);
    if (!earlierMatches || !laterMatches) continue;

    const occurrenceMs = Number(earlier.epochMilliseconds);
    const latenessMs = nowMs - occurrenceMs;
    if (latenessMs < 0 || latenessMs > maximumLatenessMs) continue;
    const localDate = date.toString();
    occurrences.push(Object.freeze({
      occurrenceKey: `${schedule.scheduleId}:${localDate}T${schedule.timeLocal}[${schedule.timezone}]`,
      scheduleId: schedule.scheduleId,
      scheduledFor: utcDateTimeSchema.parse(
        Temporal.Instant.fromEpochMilliseconds(occurrenceMs).toString({
          smallestUnit: 'millisecond',
        }),
      ),
      localDate,
      localTime: schedule.timeLocal,
      timezone: schedule.timezone,
    }));
  }

  return occurrences;
}
