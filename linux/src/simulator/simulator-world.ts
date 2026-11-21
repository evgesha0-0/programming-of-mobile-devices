import type { Clock, MotorState } from '../ports/index.js';
import { SeededRandom } from './seeded-random.js';
import type { SimulatorScenario } from './scenario.js';

export interface SimulatorWorldSnapshot {
  readonly hopperGrams: number;
  readonly bowlGrams: number;
  readonly dispensedThisRunGrams: number;
  readonly motorState: MotorState;
  readonly scenario: string;
}

export class SimulatorWorld {
  private hopperGrams: number;
  private bowlGrams: number;
  private dispensedThisRunGrams = 0;
  private motorState: MotorState = 'stopped';
  private lastSynchronizedMs: number;
  private stoppingAfterJam = false;

  constructor(
    private readonly clock: Clock,
    private readonly random: SeededRandom,
    private scenario: SimulatorScenario,
    initialHopperGrams = 1_000,
    initialBowlGrams = 0,
  ) {
    assertNonnegative(initialHopperGrams, 'initialHopperGrams');
    assertNonnegative(initialBowlGrams, 'initialBowlGrams');
    this.hopperGrams = initialHopperGrams;
    this.bowlGrams = initialBowlGrams;
    this.lastSynchronizedMs = this.clock.now().getTime();
  }

  getScenario(): SimulatorScenario {
    return this.scenario;
  }

  setScenario(scenario: SimulatorScenario): void {
    this.synchronize();
    if (this.motorState !== 'stopped') {
      throw new Error('Scenario can only be changed while the motor is stopped');
    }
    this.scenario = scenario;
  }

  getMotorState(): MotorState {
    this.synchronize();
    return this.motorState;
  }

  beginStarting(): void {
    this.synchronize();
    if (this.motorState !== 'stopped') throw new Error('Motor is not stopped');
    this.motorState = 'starting';
    this.dispensedThisRunGrams = 0;
  }

  beginRunning(): void {
    this.synchronize();
    if (this.motorState !== 'starting') throw new Error('Motor is not starting');
    this.motorState = this.scenario.motorJamAfterGrams === 0 ? 'jammed' : 'running';
    this.lastSynchronizedMs = this.clock.now().getTime();
  }

  beginStopping(): void {
    this.synchronize();
    if (this.motorState === 'stopped') return;
    this.stoppingAfterJam = this.motorState === 'jammed';
    this.motorState = 'stopping';
  }

  completeStop(): void {
    this.synchronize();
    if (this.motorState !== 'stopping') throw new Error('Motor is not stopping');
    if (!this.stoppingAfterJam) {
      this.dispense(this.scenario.inertiaGrams * this.scenario.deliveryMultiplier);
    }
    this.stoppingAfterJam = false;
    this.motorState = 'stopped';
    this.lastSynchronizedMs = this.clock.now().getTime();
  }

  emergencyStop(): void {
    this.synchronize();
    this.motorState = 'stopped';
    this.stoppingAfterJam = false;
    this.lastSynchronizedMs = this.clock.now().getTime();
  }

  bowlMassGrams(): number {
    this.synchronize();
    return this.bowlGrams;
  }

  hopperMassGrams(): number {
    this.synchronize();
    return this.hopperGrams;
  }

  refill(grams: number): void {
    assertNonnegative(grams, 'grams');
    this.synchronize();
    this.hopperGrams += grams;
  }

  reset(hopperGrams = 1_000, bowlGrams = 0): void {
    assertNonnegative(hopperGrams, 'hopperGrams');
    assertNonnegative(bowlGrams, 'bowlGrams');
    this.motorState = 'stopped';
    this.stoppingAfterJam = false;
    this.hopperGrams = hopperGrams;
    this.bowlGrams = bowlGrams;
    this.dispensedThisRunGrams = 0;
    this.lastSynchronizedMs = this.clock.now().getTime();
  }

  sensorNoiseGrams(): number {
    return this.random.gaussian() * this.scenario.sensorNoiseStdDevGrams;
  }

  snapshot(): SimulatorWorldSnapshot {
    this.synchronize();
    return Object.freeze({
      hopperGrams: roundMass(this.hopperGrams),
      bowlGrams: roundMass(this.bowlGrams),
      dispensedThisRunGrams: roundMass(this.dispensedThisRunGrams),
      motorState: this.motorState,
      scenario: this.scenario.name,
    });
  }

  private synchronize(): void {
    const nowMs = this.clock.now().getTime();
    if (nowMs < this.lastSynchronizedMs) {
      if (this.motorState !== 'stopped') {
        throw new Error('Clock moved backwards while motor was active');
      }
      this.lastSynchronizedMs = nowMs;
      return;
    }
    const elapsedSeconds = (nowMs - this.lastSynchronizedMs) / 1_000;
    this.lastSynchronizedMs = nowMs;
    if (this.motorState !== 'running' || elapsedSeconds === 0) return;

    let amount = this.scenario.flowRateGramsPerSecond
      * this.scenario.deliveryMultiplier
      * elapsedSeconds;
    const jamAfter = this.scenario.motorJamAfterGrams;
    if (jamAfter !== null) {
      const remainingBeforeJam = Math.max(0, jamAfter - this.dispensedThisRunGrams);
      if (amount >= remainingBeforeJam) {
        amount = remainingBeforeJam;
        this.motorState = 'jammed';
      }
    }
    this.dispense(amount);
  }

  private dispense(requestedGrams: number): void {
    const amount = Math.min(Math.max(requestedGrams, 0), this.hopperGrams);
    this.hopperGrams -= amount;
    this.bowlGrams += amount;
    this.dispensedThisRunGrams += amount;
  }
}

function roundMass(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function assertNonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative finite number`);
  }
}
