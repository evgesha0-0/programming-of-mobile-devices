import type { Telemetry } from '../ports/index.js';
import { DeterministicIdGenerator } from './deterministic-id-generator.js';
import { InMemoryExecutionLock } from './in-memory-execution-lock.js';
import { SeededRandom } from './seeded-random.js';
import { getSimulatorScenario, type SimulatorScenarioName } from './scenario.js';
import { SimulatedMotor } from './simulated-motor.js';
import { SimulatedWeightSensor } from './simulated-weight-sensor.js';
import { SimulatorController } from './simulator-controller.js';
import { SimulatorWorld } from './simulator-world.js';
import { VirtualClock } from './virtual-clock.js';
import { VirtualGpio } from './virtual-gpio.js';

const noOpTelemetry: Telemetry = Object.freeze({
  event() {},
  increment() {},
  gauge() {},
});

export interface CreateDigitalTwinOptions {
  readonly seed: string | number;
  readonly initialTime: Date | string | number;
  readonly scenario?: SimulatorScenarioName;
  readonly initialHopperGrams?: number;
  readonly initialBowlGrams?: number;
  readonly telemetry?: Telemetry;
}

export function createDigitalTwin(options: CreateDigitalTwinOptions) {
  const telemetry = options.telemetry ?? noOpTelemetry;
  const clock = new VirtualClock(options.initialTime);
  const world = new SimulatorWorld(
    clock,
    new SeededRandom(options.seed),
    getSimulatorScenario(options.scenario ?? 'normal'),
    options.initialHopperGrams,
    options.initialBowlGrams,
  );
  const gpio = new VirtualGpio(clock, telemetry);
  const motor = new SimulatedMotor(world, gpio, clock, telemetry);
  const weightSensor = new SimulatedWeightSensor(world, clock, telemetry);
  return Object.freeze({
    clock,
    world,
    gpio,
    motor,
    weightSensor,
    executionLock: new InMemoryExecutionLock(),
    idGenerator: new DeterministicIdGenerator(options.seed),
    controller: new SimulatorController(world, clock),
  });
}
