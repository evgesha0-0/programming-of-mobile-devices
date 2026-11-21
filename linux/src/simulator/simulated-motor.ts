import type { Clock, MotorPort, MotorState, Telemetry } from '../ports/index.js';
import { SimulatorWorld } from './simulator-world.js';
import { VirtualGpio } from './virtual-gpio.js';

export class MotorJammedError extends Error {
  constructor() {
    super('Simulated motor is jammed');
    this.name = 'MotorJammedError';
  }
}

export class SimulatedMotor implements MotorPort {
  constructor(
    private readonly world: SimulatorWorld,
    private readonly gpio: VirtualGpio,
    private readonly clock: Clock,
    private readonly telemetry: Telemetry,
  ) {}

  getState(): MotorState {
    return this.world.getMotorState();
  }

  async start(signal: AbortSignal): Promise<void> {
    this.world.beginStarting();
    this.gpio.write('emergency_stop', false);
    this.gpio.write('motor_direction', true);
    this.gpio.write('motor_enable', true);
    this.telemetry.event('motor_starting');
    try {
      await this.clock.sleep(this.world.getScenario().motorStartDelayMs, signal);
    } catch (error) {
      this.emergencyStop();
      throw error;
    }
    this.world.beginRunning();
    if (this.world.getMotorState() === 'jammed') {
      this.telemetry.increment('motor_jam');
      throw new MotorJammedError();
    }
    this.telemetry.event('motor_running');
  }

  async stop(signal: AbortSignal): Promise<void> {
    if (this.world.getMotorState() === 'stopped') return;
    this.world.beginStopping();
    this.gpio.write('motor_enable', false);
    this.telemetry.event('motor_stopping');
    try {
      await this.clock.sleep(this.world.getScenario().motorStopDelayMs, signal);
    } catch (error) {
      this.emergencyStop();
      throw error;
    }
    this.world.completeStop();
    this.gpio.write('motor_direction', false);
    this.telemetry.event('motor_stopped');
  }

  emergencyStop(): void {
    this.gpio.write('emergency_stop', true);
    this.gpio.write('motor_enable', false);
    this.gpio.write('motor_direction', false);
    this.world.emergencyStop();
    this.telemetry.increment('motor_emergency_stop');
  }
}
