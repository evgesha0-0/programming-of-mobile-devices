import { z } from 'zod';

const maximumGrams = 999_999.99;

export const utcDateTimeSchema = z.iso.datetime({ offset: false }).refine(
  (value) => value.endsWith('Z'),
  'Timestamp must be in UTC and end with Z',
);

export const localTimeSchema = z.string().regex(
  /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/,
  'Time must use HH:mm:ss format',
);

export const timezoneSchema = z.string().min(1).max(64).refine((timezone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}, 'Timezone must be a valid IANA identifier');

export const dayOfWeekSchema = z.enum([
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
]);

export const daysOfWeekSchema = z.array(dayOfWeekSchema).min(1).max(7).refine(
  (days) => new Set(days).size === days.length,
  'Days of week must be unique',
);

export const portionGramsSchema = z.number()
  .positive()
  .max(maximumGrams)
  .multipleOf(0.01);

export const actualGramsSchema = z.number()
  .nonnegative()
  .max(maximumGrams)
  .multipleOf(0.01);

export const reportedDeviceStatusSchema = z.enum(['online', 'busy', 'error', 'unknown']);
export const feedingStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'expired',
]);
export const feedingSourceSchema = z.enum(['manual', 'scheduled']);

export const errorCodeSchema = z.string().min(1).max(64).refine(
  (value) => value.trim().length > 0,
  'Error code must not be blank',
);
export const errorMessageSchema = z.string().min(1).max(2_000).refine(
  (value) => value.trim().length > 0,
  'Error message must not be blank',
);

export type UtcDateTime = z.infer<typeof utcDateTimeSchema>;
export type DayOfWeek = z.infer<typeof dayOfWeekSchema>;
export type ReportedDeviceStatus = z.infer<typeof reportedDeviceStatusSchema>;
export type FeedingStatus = z.infer<typeof feedingStatusSchema>;
export type FeedingSource = z.infer<typeof feedingSourceSchema>;
