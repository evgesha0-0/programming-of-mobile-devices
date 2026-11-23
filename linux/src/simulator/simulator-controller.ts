import { isSimulatorScenarioName, getSimulatorScenario, type SimulatorScenarioName } from './scenario.js';
import { SimulatorWorld, type SimulatorWorldSnapshot } from './simulator-world.js';
import { VirtualClock } from './virtual-clock.js';

export type SimulatorControlCommand =
  | Readonly<{ action: 'status' }>
  | Readonly<{ action: 'scenario'; name: SimulatorScenarioName }>
  | Readonly<{ action: 'advance'; milliseconds: number }>
  | Readonly<{ action: 'refill'; grams: number }>
  | Readonly<{ action: 'reset'; hopperGrams?: number; bowlGrams?: number }>;

export interface SimulatorControlResult {
  readonly ok: true;
  readonly world: SimulatorWorldSnapshot;
  readonly now: string;
}

export class SimulatorController {
  constructor(
    private readonly world: SimulatorWorld,
    private readonly clock: VirtualClock,
  ) {}

  async execute(command: SimulatorControlCommand): Promise<SimulatorControlResult> {
    switch (command.action) {
      case 'status':
        break;
      case 'scenario':
        this.world.setScenario(getSimulatorScenario(command.name));
        break;
      case 'advance':
        await this.clock.advanceBy(command.milliseconds);
        break;
      case 'refill':
        this.world.refill(command.grams);
        break;
      case 'reset':
        this.world.reset(command.hopperGrams ?? 1_000, command.bowlGrams ?? 0);
        break;
    }
    return Object.freeze({
      ok: true,
      world: this.world.snapshot(),
      now: this.clock.now().toISOString(),
    });
  }
}

export function parseSimulatorControlCommand(candidate: unknown): SimulatorControlCommand {
  if (typeof candidate !== 'object' || candidate === null || !('action' in candidate)) {
    throw new TypeError('Simulator command must be an object with action');
  }
  const command = candidate as Record<string, unknown>;
  switch (command.action) {
    case 'status':
      return { action: 'status' };
    case 'scenario':
      if (typeof command.name !== 'string' || !isSimulatorScenarioName(command.name)) {
        throw new TypeError('Unknown simulator scenario');
      }
      return { action: 'scenario', name: command.name };
    case 'advance':
      return { action: 'advance', milliseconds: finiteNonnegative(command.milliseconds, 'milliseconds') };
    case 'refill':
      return { action: 'refill', grams: finiteNonnegative(command.grams, 'grams') };
    case 'reset':
      return {
        action: 'reset',
        ...(command.hopperGrams === undefined
          ? {}
          : { hopperGrams: finiteNonnegative(command.hopperGrams, 'hopperGrams') }),
        ...(command.bowlGrams === undefined
          ? {}
          : { bowlGrams: finiteNonnegative(command.bowlGrams, 'bowlGrams') }),
      };
    default:
      throw new TypeError('Unknown simulator action');
  }
}

function finiteNonnegative(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative finite number`);
  }
  return value;
}
