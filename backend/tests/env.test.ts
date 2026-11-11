import assert from 'node:assert/strict';
import test from 'node:test';

import { loadEnv } from '../src/config/env.js';

const requiredEnvironment = {
  DB_HOST: 'localhost',
  DB_NAME: 'smart_cat_feeder',
  DB_USER: 'feeder',
  DB_PASSWORD: 'secret',
};

test('environment uses the documented offline threshold by default', () => {
  const config = loadEnv(requiredEnvironment);
  assert.equal(config.deviceOfflineAfterSeconds, 120);
});

test('environment accepts an explicit offline threshold', () => {
  const config = loadEnv({
    ...requiredEnvironment,
    DEVICE_OFFLINE_AFTER_SECONDS: '300',
  });
  assert.equal(config.deviceOfflineAfterSeconds, 300);
});

test('environment rejects invalid offline thresholds', () => {
  for (const value of ['0', '-1', '1.5', '86401', 'invalid']) {
    assert.throws(
      () => loadEnv({
        ...requiredEnvironment,
        DEVICE_OFFLINE_AFTER_SECONDS: value,
      }),
      /DEVICE_OFFLINE_AFTER_SECONDS/,
    );
  }
});
