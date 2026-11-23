import type { Clock } from '../ports/index.js';

interface ClockWaiter {
  readonly dueAtMs: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

export class VirtualClock implements Clock {
  private currentMs: number;
  private readonly waiters: ClockWaiter[] = [];

  constructor(
    initialTime: Date | string | number,
    private readonly autoAdvance = false,
  ) {
    this.currentMs = toMilliseconds(initialTime);
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      return Promise.reject(new RangeError('delayMs must be a nonnegative finite number'));
    }
    if (signal.aborted) return Promise.reject(abortError());
    if (delayMs === 0) return Promise.resolve();
    if (this.autoAdvance) {
      return this.advanceBy(delayMs).then(() => {
        if (signal.aborted) throw abortError();
      });
    }

    return new Promise((resolve, reject) => {
      const waiter: ClockWaiter = {
        dueAtMs: this.currentMs + delayMs,
        resolve,
        reject,
        signal,
        onAbort: () => {
          this.removeWaiter(waiter);
          reject(abortError());
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.waiters.sort((left, right) => left.dueAtMs - right.dueAtMs);
    });
  }

  async advanceBy(milliseconds: number): Promise<void> {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError('milliseconds must be a nonnegative finite number');
    }
    await this.advanceTo(this.currentMs + milliseconds);
  }

  async advanceTo(target: Date | string | number): Promise<void> {
    const targetMs = toMilliseconds(target);
    if (targetMs < this.currentMs) throw new RangeError('Virtual clock cannot advance backwards');

    while (true) {
      const nextDueAt = this.waiters[0]?.dueAtMs;
      if (nextDueAt === undefined || nextDueAt > targetMs) break;
      this.currentMs = nextDueAt;
      const due = this.waiters.filter((waiter) => waiter.dueAtMs <= nextDueAt);
      for (const waiter of due) {
        this.removeWaiter(waiter);
        waiter.resolve();
      }
      await Promise.resolve();
    }
    this.currentMs = targetMs;
    await Promise.resolve();
  }

  setTime(target: Date | string | number): void {
    if (this.waiters.length > 0) {
      throw new Error('Cannot set virtual time while sleeps are pending');
    }
    this.currentMs = toMilliseconds(target);
  }

  pendingSleeps(): number {
    return this.waiters.length;
  }

  private removeWaiter(waiter: ClockWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    waiter.signal.removeEventListener('abort', waiter.onAbort);
  }
}

function toMilliseconds(value: Date | string | number): number {
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new RangeError('Invalid virtual clock time');
  return milliseconds;
}

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError');
}
