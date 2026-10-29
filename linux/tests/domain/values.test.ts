import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actualGramsSchema,
  daysOfWeekSchema,
  deviceIdSchema,
  localTimeSchema,
  portionGramsSchema,
  reportedDeviceStatusSchema,
  timezoneSchema,
  utcDateTimeSchema,
} from '../../src/domain/index.js';

test('domain values accept documented API representations', () => {
  assert.equal(deviceIdSchema.safeParse('d6d174f4-e79f-49d1-9476-78bc99483752').success, true);
  assert.equal(utcDateTimeSchema.safeParse('2026-10-29T08:15:30.123Z').success, true);
  assert.equal(localTimeSchema.safeParse('08:30:00').success, true);
  assert.equal(timezoneSchema.safeParse('Asia/Vladivostok').success, true);
  assert.equal(daysOfWeekSchema.safeParse(['mon', 'wed', 'fri']).success, true);
  assert.equal(portionGramsSchema.safeParse(45.5).success, true);
  assert.equal(actualGramsSchema.safeParse(0).success, true);
  assert.equal(reportedDeviceStatusSchema.safeParse('busy').success, true);
});

test('domain values reject malformed or unsafe representations', () => {
  assert.equal(deviceIdSchema.safeParse('not-a-uuid').success, false);
  assert.equal(utcDateTimeSchema.safeParse('2026-10-29T11:15:30+03:00').success, false);
  assert.equal(localTimeSchema.safeParse('24:00:00').success, false);
  assert.equal(timezoneSchema.safeParse('Not/A-Timezone').success, false);
  assert.equal(daysOfWeekSchema.safeParse(['mon', 'mon']).success, false);
  assert.equal(daysOfWeekSchema.safeParse([]).success, false);
  assert.equal(portionGramsSchema.safeParse(0).success, false);
  assert.equal(portionGramsSchema.safeParse(10.001).success, false);
  assert.equal(actualGramsSchema.safeParse(-0.01).success, false);
  assert.equal(reportedDeviceStatusSchema.safeParse('offline').success, false);
});
