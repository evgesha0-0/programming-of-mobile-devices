import { RuntimeConfigurationError } from '../config/index.js';
import { bootstrapRuntime, type BootstrapRuntimeOptions } from './bootstrap.js';

export async function runRuntime(options: BootstrapRuntimeOptions = {}): Promise<void> {
  const runtime = bootstrapRuntime(options);
  const controller = new AbortController();
  const shutdown = createShutdownWaiter();
  const reporter = runtime.deviceStateReporter.run(controller.signal);
  const scheduleSync = runtime.scheduleSyncService.run(controller.signal);
  const services = [reporter, scheduleSync] as const;
  try {
    const outcome = await Promise.race([
      reporter.then(() => ({ kind: 'reporter' as const })),
      scheduleSync.then(() => ({ kind: 'schedule_sync' as const })),
      shutdown.promise.then((signal) => ({ kind: 'signal' as const, signal })),
    ]);
    if (outcome.kind !== 'signal') {
      throw new Error(`${outcome.kind} service stopped unexpectedly`);
    }
    runtime.logger.info('runtime_shutdown_requested', { signal: outcome.signal });
    controller.abort();
    runtime.backendGateway.close();
    await Promise.all(services);
  } finally {
    shutdown.cancel();
    controller.abort();
    runtime.backendGateway.close();
    await Promise.allSettled(services);
    runtime.close();
  }
}

export function safeStartupFailureMessage(error: unknown): string {
  return error instanceof RuntimeConfigurationError
    ? error.message
    : 'Runtime startup failed';
}

interface ShutdownWaiter {
  readonly promise: Promise<'SIGINT' | 'SIGTERM'>;
  cancel(): void;
}

function createShutdownWaiter(): ShutdownWaiter {
  let onSigint: () => void;
  let onSigterm: () => void;
  const promise = new Promise<'SIGINT' | 'SIGTERM'>((resolve) => {
    const finish = (signal: 'SIGINT' | 'SIGTERM'): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolve(signal);
    };
    onSigint = (): void => finish('SIGINT');
    onSigterm = (): void => finish('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
  return {
    promise,
    cancel(): void {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    },
  };
}
