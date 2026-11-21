import type { Clock, Telemetry } from '../ports/index.js';

export type VirtualGpioLine = 'motor_enable' | 'motor_direction' | 'emergency_stop';

export interface VirtualGpioTransition {
  readonly line: VirtualGpioLine;
  readonly value: boolean;
  readonly at: string;
}

export class VirtualGpio {
  private readonly values: Record<VirtualGpioLine, boolean> = {
    motor_enable: false,
    motor_direction: false,
    emergency_stop: false,
  };
  private readonly history: VirtualGpioTransition[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly telemetry: Telemetry,
  ) {}

  write(line: VirtualGpioLine, value: boolean): void {
    if (this.values[line] === value) return;
    this.values[line] = value;
    const transition = Object.freeze({
      line,
      value,
      at: this.clock.now().toISOString(),
    });
    this.history.push(transition);
    this.telemetry.event('gpio_transition', { line, value, at: transition.at });
  }

  read(line: VirtualGpioLine): boolean {
    return this.values[line];
  }

  transitions(): readonly VirtualGpioTransition[] {
    return Object.freeze([...this.history]);
  }

  resetSafe(): void {
    this.write('motor_enable', false);
    this.write('motor_direction', false);
    this.write('emergency_stop', false);
  }
}
