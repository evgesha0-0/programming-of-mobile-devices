import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  WeightSensorDisconnectedError,
  WeightSensorTimeoutError,
  SimulatorControlServer,
  createDigitalTwin,
  sendSimulatorControlCommand,
} from '../../src/simulator/index.js';

const initialTime = '2026-11-21T12:00:00.000Z';

test('motor moves mass from hopper to bowl and scale reads the shared world', async () => {
  const twin = createDigitalTwin({
    seed: 'physics-seed',
    initialTime,
    initialHopperGrams: 100,
  });
  const signal = new AbortController().signal;

  const tare = twin.weightSensor.tare(signal);
  await twin.clock.advanceBy(50);
  await tare;

  const start = twin.motor.start(signal);
  assert.equal(twin.motor.getState(), 'starting');
  assert.equal(twin.gpio.read('motor_enable'), true);
  await twin.clock.advanceBy(200);
  await start;
  assert.equal(twin.motor.getState(), 'running');

  await twin.clock.advanceBy(2_000);
  const read = twin.weightSensor.readGrams(signal);
  await twin.clock.advanceBy(50);
  const measuredWhileRunning = await read;
  assert.ok(measuredWhileRunning >= 20 && measuredWhileRunning <= 21);

  const stop = twin.motor.stop(signal);
  assert.equal(twin.gpio.read('motor_enable'), false);
  await twin.clock.advanceBy(150);
  await stop;

  const world = twin.world.snapshot();
  assert.equal(world.motorState, 'stopped');
  assert.equal(Math.round((world.hopperGrams + world.bowlGrams) * 1000) / 1000, 100);
  assert.equal(world.bowlGrams, 21.3);
  assert.equal(twin.gpio.read('motor_direction'), false);
  assert.ok(twin.gpio.transitions().length >= 4);
});

test('underfeed and overfeed alter physical flow instead of returning preset grams', async () => {
  const underfeed = await dispenseForOneSecond('underfeed');
  const normal = await dispenseForOneSecond('normal');
  const overfeed = await dispenseForOneSecond('overfeed');

  assert.ok(underfeed > 0);
  assert.ok(underfeed < normal);
  assert.ok(normal < overfeed);
  assert.equal(underfeed, 5.94);
  assert.equal(normal, 10.8);
  assert.equal(overfeed, 15.66);
});

test('motor jam stops physical flow at the configured threshold', async () => {
  const twin = createDigitalTwin({ seed: 'jam-seed', initialTime, scenario: 'motor-jam' });
  const signal = new AbortController().signal;
  const start = twin.motor.start(signal);
  await twin.clock.advanceBy(200);
  await start;
  await twin.clock.advanceBy(1_000);

  assert.equal(twin.motor.getState(), 'jammed');
  assert.equal(twin.world.snapshot().bowlGrams, 5);

  const stop = twin.motor.stop(signal);
  await twin.clock.advanceBy(150);
  await stop;
  assert.equal(twin.world.snapshot().bowlGrams, 5);
  assert.equal(twin.motor.getState(), 'stopped');
});

test('weight sensor supports timeout and disconnected scenarios', async () => {
  const timeoutTwin = createDigitalTwin({
    seed: 'timeout-seed',
    initialTime,
    scenario: 'sensor-timeout',
  });
  const timeoutAssertion = assert.rejects(
    timeoutTwin.weightSensor.readGrams(new AbortController().signal),
    WeightSensorTimeoutError,
  );
  await timeoutTwin.clock.advanceBy(5_000);
  await timeoutAssertion;

  const disconnectedTwin = createDigitalTwin({
    seed: 'disconnect-seed',
    initialTime,
    scenario: 'sensor-disconnect',
  });
  await assert.rejects(
    disconnectedTwin.weightSensor.readGrams(new AbortController().signal),
    WeightSensorDisconnectedError,
  );
});

test('same seed produces the same sensor noise and feeding identifiers', async () => {
  const first = createDigitalTwin({ seed: 'deterministic', initialTime });
  const second = createDigitalTwin({ seed: 'deterministic', initialTime });
  const firstRead = first.weightSensor.readGrams(new AbortController().signal);
  const secondRead = second.weightSensor.readGrams(new AbortController().signal);
  await first.clock.advanceBy(50);
  await second.clock.advanceBy(50);

  assert.equal(await firstRead, await secondRead);
  assert.equal(first.idGenerator.generateFeedingId(), second.idGenerator.generateFeedingId());
  assert.equal(first.idGenerator.generateFeedingId(), second.idGenerator.generateFeedingId());
});

test('execution lock serializes owners and supports cancellation', async () => {
  const twin = createDigitalTwin({ seed: 'lock-seed', initialTime });
  const first = await twin.executionLock.acquire('manual', new AbortController().signal);
  const secondPromise = twin.executionLock.acquire('scheduled', new AbortController().signal);
  assert.equal(twin.executionLock.isLocked(), true);
  first.release();
  const second = await secondPromise;
  assert.equal(second.owner, 'scheduled');
  second.release();
  assert.equal(twin.executionLock.isLocked(), false);

  const held = await twin.executionLock.acquire('held', new AbortController().signal);
  const cancelled = new AbortController();
  const waiting = assert.rejects(
    twin.executionLock.acquire('cancelled', cancelled.signal),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  cancelled.abort();
  await waiting;
  held.release();
});

test('local control socket changes scenarios without opening TCP', async (t) => {
  const twin = createDigitalTwin({ seed: 'socket-seed', initialTime });
  const socketPath = simulatorSocketPath(t);
  const server = new SimulatorControlServer(twin.controller, socketPath);
  await server.start();
  t.after(() => server.close());

  const changed = await sendSimulatorControlCommand(socketPath, {
    action: 'scenario',
    name: 'underfeed',
  });
  assert.equal(changed.world.scenario, 'underfeed');

  const advanced = await sendSimulatorControlCommand(socketPath, {
    action: 'advance',
    milliseconds: 1_000,
  });
  assert.equal(advanced.now, '2026-11-21T12:00:01.000Z');

  const refilled = await sendSimulatorControlCommand(socketPath, {
    action: 'refill',
    grams: 25,
  });
  assert.equal(refilled.world.hopperGrams, 1_025);
});

async function dispenseForOneSecond(
  scenario: 'normal' | 'underfeed' | 'overfeed',
): Promise<number> {
  const twin = createDigitalTwin({ seed: `seed-${scenario}`, initialTime, scenario });
  const signal = new AbortController().signal;
  const start = twin.motor.start(signal);
  await twin.clock.advanceBy(200);
  await start;
  await twin.clock.advanceBy(1_000);
  const stop = twin.motor.stop(signal);
  await twin.clock.advanceBy(150);
  await stop;
  return twin.world.snapshot().bowlGrams;
}

function simulatorSocketPath(t: TestContext): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\smart-cat-feeder-${randomUUID()}`;
  }
  const directory = mkdtempSync(join(tmpdir(), 'smart-cat-feeder-control-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'control.sock');
}
