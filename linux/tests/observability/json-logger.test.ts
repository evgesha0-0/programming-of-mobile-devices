import assert from 'node:assert/strict';
import test from 'node:test';

import { createJsonLogger } from '../../src/observability/index.js';

const deviceToken = `dvc_${'B'.repeat(43)}`;

test('JSON logger redacts secret keys and secret values recursively', () => {
  const lines: string[] = [];
  const logger = createJsonLogger({
    level: 'debug',
    secrets: [deviceToken],
    sink: (line) => lines.push(line),
    now: () => new Date('2026-11-21T06:00:00Z'),
  });

  logger.error(`request failed for ${deviceToken}`, {
    deviceToken,
    authorization: `Bearer ${deviceToken}`,
    nested: {
      message: `Backend rejected ${deviceToken}`,
      error: new Error(`Invalid token ${deviceToken}`),
    },
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.includes(deviceToken), false);
  const record = JSON.parse(lines[0] ?? '{}') as {
    event: string;
    data: Record<string, unknown>;
  };
  assert.equal(record.event, 'request failed for [REDACTED]');
  assert.equal(record.data.deviceToken, '[REDACTED]');
  assert.equal(record.data.authorization, '[REDACTED]');
  assert.equal(JSON.stringify(record.data).includes(deviceToken), false);
});

test('JSON logger respects the configured minimum level', () => {
  const lines: string[] = [];
  const logger = createJsonLogger({
    level: 'warn',
    sink: (line) => lines.push(line),
  });

  logger.debug('debug_event');
  logger.info('info_event');
  logger.warn('warn_event');

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.includes('warn_event'), true);
});
