import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  loadRuntimeConfig,
  RuntimeConfigurationError,
  runtimeConfigSummary,
} from '../../src/config/index.js';

const deviceToken = `dvc_${'A'.repeat(43)}`;
const deviceId = 'd6d174f4-e79f-49d1-9476-78bc99483752';

test('runtime config validates and freezes direct environment settings', () => {
  const cwd = resolve('runtime-root');
  const config = loadRuntimeConfig(validEnvironment(), { cwd });

  assert.equal(config.backendUrl, 'https://backend.example.test');
  assert.equal(config.deviceId, deviceId);
  assert.equal(config.deviceToken, deviceToken);
  assert.equal(config.sqlitePath, resolve(cwd, 'data/device.sqlite'));
  assert.deepEqual(config.intervals, {
    heartbeatMs: 30_000,
    scheduleSyncMs: 60_000,
    commandPollMs: 5_000,
  });
  assert.deepEqual(config.backoff, { initialMs: 1_000, maxMs: 60_000 });
  assert.equal(config.requestTimeoutMs, 10_000);
  assert.equal(config.maxClockSkewMs, 30_000);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.intervals), true);
  assert.equal(JSON.stringify(runtimeConfigSummary(config)).includes(deviceToken), false);
});

test('DEVICE_ID is normalized to the lowercase UUID used by backend credentials', () => {
  const config = loadRuntimeConfig({ ...validEnvironment(), DEVICE_ID: deviceId.toUpperCase() });
  assert.equal(config.deviceId, deviceId);
});

test('runtime config reads a custom command poll interval', () => {
  const config = loadRuntimeConfig({ ...validEnvironment(), COMMAND_POLL_INTERVAL_MS: '2500' });
  assert.equal(config.intervals.commandPollMs, 2_500);
});

test('runtime config reads DEVICE_TOKEN_FILE without retaining its path', () => {
  const cwd = resolve('runtime-root');
  let requestedPath = '';
  const environment = validEnvironment();
  delete environment.DEVICE_TOKEN;
  environment.DEVICE_TOKEN_FILE = './secrets/device-token';

  const config = loadRuntimeConfig(environment, {
    cwd,
    readSecretFile(path) {
      requestedPath = path;
      return `${deviceToken}\n`;
    },
  });

  assert.equal(requestedPath, resolve(cwd, 'secrets/device-token'));
  assert.equal(config.deviceToken, deviceToken);
  assert.equal('deviceTokenFile' in config, false);
});

test('runtime config rejects unsafe values without exposing the token', () => {
  const invalidToken = 'dvc_this-must-not-appear-in-an-error';
  const cases: Array<Readonly<Record<string, string | undefined>>> = [
    { ...validEnvironment(), DEVICE_TOKEN: undefined },
    { ...validEnvironment(), DEVICE_TOKEN_FILE: './token' },
    { ...validEnvironment(), DEVICE_TOKEN: invalidToken },
    { ...validEnvironment(), BACKEND_URL: 'http://backend.example.test' },
    { ...validEnvironment(), DEVICE_ID: 'not-a-uuid' },
    { ...validEnvironment(), SQLITE_PATH: ':memory:' },
    { ...validEnvironment(), HARDWARE_ADAPTER: 'gpio' },
    { ...validEnvironment(), HEARTBEAT_INTERVAL_MS: '999' },
    { ...validEnvironment(), COMMAND_POLL_INTERVAL_MS: '999' },
    { ...validEnvironment(), BACKOFF_INITIAL_MS: '60001' },
    { ...validEnvironment(), MAX_CLOCK_SKEW_MS: '300001' },
  ];

  for (const environment of cases) {
    assert.throws(
      () => loadRuntimeConfig(environment),
      RuntimeConfigurationError,
    );
  }

  try {
    loadRuntimeConfig({ ...validEnvironment(), DEVICE_TOKEN: invalidToken });
    assert.fail('Expected configuration failure');
  } catch (error) {
    assert.equal(String(error).includes(invalidToken), false);
  }
});

test('runtime config only allows development HTTP on loopback', () => {
  const config = loadRuntimeConfig({
    ...validEnvironment(),
    NODE_ENV: 'development',
    BACKEND_URL: 'http://127.0.0.1:3000/',
  });
  assert.equal(config.backendUrl, 'http://127.0.0.1:3000');

  assert.throws(() => loadRuntimeConfig({
    ...validEnvironment(),
    NODE_ENV: 'production',
    BACKEND_URL: 'http://127.0.0.1:3000',
  }), RuntimeConfigurationError);
});

test('runtime config rejects malformed secret file contents', () => {
  const environment = validEnvironment();
  delete environment.DEVICE_TOKEN;
  environment.DEVICE_TOKEN_FILE = './secret';

  assert.throws(() => loadRuntimeConfig(environment, {
    readSecretFile: () => `${deviceToken}\nsecond-line\n`,
  }), RuntimeConfigurationError);
});

function validEnvironment(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    HARDWARE_ADAPTER: 'simulator',
    BACKEND_URL: 'https://backend.example.test/',
    DEVICE_ID: deviceId,
    DEVICE_TOKEN: deviceToken,
    SQLITE_PATH: './data/device.sqlite',
    HEARTBEAT_INTERVAL_MS: '30000',
    SCHEDULE_SYNC_INTERVAL_MS: '60000',
    REQUEST_TIMEOUT_MS: '10000',
    BACKOFF_INITIAL_MS: '1000',
    BACKOFF_MAX_MS: '60000',
    MAX_CLOCK_SKEW_MS: '30000',
  };
}
