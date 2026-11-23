import { setTimeout as sleepWithSignal } from 'node:timers/promises';

import type { Clock } from '../../ports/index.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  async sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    await sleepWithSignal(delayMs, undefined, { signal });
  }
}
