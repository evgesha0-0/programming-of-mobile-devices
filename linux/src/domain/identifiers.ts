import { z } from 'zod';

const uuidSchema = z.string().uuid();

export const deviceIdSchema = uuidSchema.brand<'DeviceId'>();
export const scheduleIdSchema = uuidSchema.brand<'ScheduleId'>();
export const commandIdSchema = uuidSchema.brand<'CommandId'>();
export const feedingIdSchema = uuidSchema.brand<'FeedingId'>();

export type DeviceId = z.infer<typeof deviceIdSchema>;
export type ScheduleId = z.infer<typeof scheduleIdSchema>;
export type CommandId = z.infer<typeof commandIdSchema>;
export type FeedingId = z.infer<typeof feedingIdSchema>;
