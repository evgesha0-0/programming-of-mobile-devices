import { runRuntime, safeStartupFailureMessage } from './runtime/index.js';

try {
  await runRuntime();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    event: 'runtime_start_failed',
    data: { message: safeStartupFailureMessage(error) },
  })}\n`);
  process.exitCode = 1;
}
