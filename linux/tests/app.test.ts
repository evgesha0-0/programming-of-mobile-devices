import assert from 'node:assert/strict';
import test from 'node:test';

import { createStartupEvent, serviceMetadata } from '../src/app.js';

test('Linux service scaffold is configured for the simulator adapter', () => {
  assert.deepEqual(serviceMetadata, {
    name: 'smart-cat-feeder-linux',
    version: '0.1.0',
    hardwareAdapter: 'simulator',
  });
  assert.deepEqual(createStartupEvent(), {
    event: 'scaffold_ready',
    service: 'smart-cat-feeder-linux',
    version: '0.1.0',
    hardware_adapter: 'simulator',
  });
});
