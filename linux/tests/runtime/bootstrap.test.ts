import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeConfigurationError } from '../../src/config/index.js';
import {
  bootstrapRuntime,
  safeStartupFailureMessage,
  type RuntimeDependencies,
} from '../../src/runtime/index.js';
import type { BackendGateway } from '../../src/ports/index.js';
import type { LocalStore } from '../../src/ports/index.js';

const deviceToken = `dvc_${'C'.repeat(43)}`;

test('invalid configuration fails before opening storage or network', () => {
  let storeOpened = false;
  let networkOpened = false;
  const dependencies: RuntimeDependencies = {
    openStore() {
      storeOpened = true;
      return fakeLocalStore(() => {});
    },
    openNetwork() {
      networkOpened = true;
      return fakeBackendGateway(() => {});
    },
  };

  assert.throws(() => bootstrapRuntime({
    environment: { ...validEnvironment(), BACKEND_URL: 'not-a-url' },
    dependencies,
  }), RuntimeConfigurationError);
  assert.equal(storeOpened, false);
  assert.equal(networkOpened, false);
});

test('runtime opens resources after validation and closes them in reverse order', () => {
  const events: string[] = [];
  const logLines: string[] = [];
  const dependencies: RuntimeDependencies = {
    openStore(sqlitePath) {
      events.push(`store:${sqlitePath}`);
      assert.equal(sqlitePath.includes(deviceToken), false);
      return fakeLocalStore(() => events.push('store:close'));
    },
    openNetwork(config) {
      events.push('network:open');
      assert.equal(config.deviceToken, deviceToken);
      return fakeBackendGateway(() => events.push('network:close'));
    },
  };

  const runtime = bootstrapRuntime({
    environment: validEnvironment(),
    dependencies,
    logSink: (line) => logLines.push(line),
    now: () => new Date('2026-11-21T06:00:00Z'),
  });
  runtime.close();
  runtime.close();

  assert.equal(events[0]?.startsWith('store:'), true);
  assert.deepEqual(events.slice(1), ['network:open', 'network:close', 'store:close']);
  assert.equal(logLines.some((line) => line.includes(deviceToken)), false);
  assert.equal(logLines.some((line) => line.includes('runtime_started')), true);
});

test('runtime closes storage if later network initialization fails', () => {
  const events: string[] = [];
  assert.throws(() => bootstrapRuntime({
    environment: validEnvironment(),
    logSink: () => {},
    dependencies: {
      openStore() {
        events.push('store:open');
        return fakeLocalStore(() => events.push('store:close'));
      },
      openNetwork() {
        events.push('network:open');
        throw new Error('network failed');
      },
    },
  }), /network failed/);
  assert.deepEqual(events, ['store:open', 'network:open', 'store:close']);
});

test('unexpected startup failures do not expose internal error details', () => {
  assert.equal(
    safeStartupFailureMessage(new Error(`Connection failed with ${deviceToken}`)),
    'Runtime startup failed',
  );
});

function fakeBackendGateway(close: () => void): BackendGateway {
  return { close } as BackendGateway;
}

function fakeLocalStore(close: () => void): LocalStore {
  return { close } as LocalStore;
}

function validEnvironment(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    HARDWARE_ADAPTER: 'simulator',
    BACKEND_URL: 'https://backend.example.test',
    DEVICE_ID: 'd6d174f4-e79f-49d1-9476-78bc99483752',
    DEVICE_TOKEN: deviceToken,
    SQLITE_PATH: './data/device.sqlite',
  };
}
