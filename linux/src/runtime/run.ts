import { RuntimeConfigurationError } from '../config/index.js';
import { bootstrapRuntime, type BootstrapRuntimeOptions } from './bootstrap.js';

export async function runRuntime(options: BootstrapRuntimeOptions = {}): Promise<void> {
  const runtime = bootstrapRuntime(options);
  const controller = new AbortController();
  const shutdown = createShutdownWaiter(controller);
  let running: Array<{ name: string; done: Promise<void> }> = [];
  let outcomes: PromiseSettledResult<void>[];
  try {
    await runtime.simulatorControlServer.start();
    if (!controller.signal.aborted) {
      running = Object.entries({
        reporter: runtime.deviceStateReporter,
        schedule_sync: runtime.scheduleSyncService,
        command_poll: runtime.commandPoller,
        manual_feeding: runtime.manualFeedingWorker,
        outbox_delivery: runtime.outboxDeliveryService,
        scheduler: runtime.localScheduler,
      }).map(([name, service]) => ({
        name,
        done: Promise.resolve().then(() => service.run(controller.signal)),
      }));
    }
    const signal = await Promise.race([
      shutdown.promise,
      ...running.map(({ name, done }) => done.then(() => {
        throw new Error(`${name} service stopped unexpectedly`);
      })),
    ]);
    runtime.logger.info('runtime_shutdown_requested', { signal });
  } finally {
    controller.abort();
    try {
      try {
        runtime.closeNetwork();
      } finally {
        // An active feeding can still be stopping the motor and committing its result.
        outcomes = await Promise.allSettled(running.map(({ done }) => done));
        try {
          await runtime.simulatorControlServer.close();
        } finally {
          runtime.close();
        }
      }
    } finally {
      shutdown.cancel();
    }
  }

  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') throw outcome.reason;
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

function createShutdownWaiter(controller: AbortController): ShutdownWaiter {
  let onSigint: () => void;
  let onSigterm: () => void;
  const promise = new Promise<'SIGINT' | 'SIGTERM'>((resolve) => {
    const finish = (signal: 'SIGINT' | 'SIGTERM'): void => {
      resolve(signal);
      controller.abort();
    };
    onSigint = (): void => finish('SIGINT');
    onSigterm = (): void => finish('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  });
  return {
    promise,
    cancel(): void {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    },
  };
}
