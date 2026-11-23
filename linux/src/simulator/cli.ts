import { sendSimulatorControlCommand } from './control-socket.js';
import {
  isSimulatorScenarioName,
  type SimulatorScenarioName,
} from './scenario.js';
import type { SimulatorControlCommand } from './simulator-controller.js';

const defaultSocketPath = process.platform === 'win32'
  ? '\\\\.\\pipe\\smart-cat-feeder-simulator'
  : '/tmp/smart-cat-feeder-simulator.sock';

try {
  const command = parseArguments(process.argv.slice(2));
  const result = await sendSimulatorControlCommand(
    process.env.SIMULATOR_SOCKET_PATH ?? defaultSocketPath,
    command,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : 'Simulator CLI failed',
  })}\n`);
  process.exitCode = 1;
}

function parseArguments(arguments_: readonly string[]): SimulatorControlCommand {
  const [action, first, second] = arguments_;
  switch (action) {
    case 'status':
      return { action: 'status' };
    case 'scenario':
      if (!first || !isSimulatorScenarioName(first)) throw new Error('Unknown simulator scenario');
      return { action: 'scenario', name: first as SimulatorScenarioName };
    case 'advance':
      return { action: 'advance', milliseconds: parseNonnegative(first, 'milliseconds') };
    case 'refill':
      return { action: 'refill', grams: parseNonnegative(first, 'grams') };
    case 'reset':
      return {
        action: 'reset',
        ...(first === undefined ? {} : { hopperGrams: parseNonnegative(first, 'hopperGrams') }),
        ...(second === undefined ? {} : { bowlGrams: parseNonnegative(second, 'bowlGrams') }),
      };
    default:
      throw new Error('Usage: simctl status|scenario|advance|refill|reset');
  }
}

function parseNonnegative(value: string | undefined, name: string): number {
  const numeric = Number(value);
  if (value === undefined || !Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`${name} must be a nonnegative number`);
  }
  return numeric;
}
