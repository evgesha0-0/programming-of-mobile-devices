import type { Clock, Telemetry, WeightSensorPort } from '../ports/index.js';
import { SimulatorWorld } from './simulator-world.js';

export class WeightSensorDisconnectedError extends Error {
  constructor() {
    super('Simulated weight sensor is disconnected');
    this.name = 'WeightSensorDisconnectedError';
  }
}

export class WeightSensorTimeoutError extends Error {
  constructor() {
    super('Simulated weight sensor timed out');
    this.name = 'WeightSensorTimeoutError';
  }
}

export class SimulatedWeightSensor implements WeightSensorPort {
  private tareGrams = 0;

  constructor(
    private readonly world: SimulatorWorld,
    private readonly clock: Clock,
    private readonly telemetry: Telemetry,
  ) {}

  async tare(signal: AbortSignal): Promise<void> {
    await this.waitForReading(signal);
    this.tareGrams = this.world.bowlMassGrams();
    this.telemetry.event('weight_sensor_tared', { tareGrams: roundMass(this.tareGrams) });
  }

  async readGrams(signal: AbortSignal): Promise<number> {
    await this.waitForReading(signal);
    const scenario = this.world.getScenario();
    const raw = this.world.bowlMassGrams() - this.tareGrams + this.world.sensorNoiseGrams();
    const quantized = Math.round(raw / scenario.sensorQuantizationGrams)
      * scenario.sensorQuantizationGrams;
    const grams = roundMass(quantized);
    this.telemetry.gauge('weight_sensor_grams', grams);
    return grams;
  }

  private async waitForReading(signal: AbortSignal): Promise<void> {
    const scenario = this.world.getScenario();
    if (scenario.sensorFault === 'disconnected') {
      this.telemetry.increment('weight_sensor_disconnect');
      throw new WeightSensorDisconnectedError();
    }
    if (scenario.sensorFault === 'timeout') {
      await this.clock.sleep(scenario.sensorTimeoutMs, signal);
      this.telemetry.increment('weight_sensor_timeout');
      throw new WeightSensorTimeoutError();
    }
    await this.clock.sleep(scenario.sensorReadDelayMs, signal);
  }
}

function roundMass(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
