import { RuntimeConfigurationError } from '../config/index.js';
import { bootstrapRuntime, type BootstrapRuntimeOptions } from './bootstrap.js';

export async function runRuntime(options: BootstrapRuntimeOptions = {}): Promise<void> {
  const runtime = bootstrapRuntime(options);
  try {
    const signal = await waitForShutdownSignal();
    runtime.logger.info('runtime_shutdown_requested', { signal });
  } finally {
    runtime.close();
  }
}

export function safeStartupFailureMessage(error: unknown): string {
  return error instanceof RuntimeConfigurationError
    ? error.message
    : 'Runtime startup failed';
}

function waitForShutdownSignal(): Promise<'SIGINT' | 'SIGTERM'> {
  return new Promise((resolve) => {
    const finish = (signal: 'SIGINT' | 'SIGTERM'): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolve(signal);
    };
    const onSigint = (): void => finish('SIGINT');
    const onSigterm = (): void => finish('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
}
