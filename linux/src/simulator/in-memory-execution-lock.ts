import type { ExecutionLease, ExecutionLock } from '../ports/index.js';

interface LockWaiter {
  readonly owner: string;
  readonly signal: AbortSignal;
  readonly resolve: (lease: ExecutionLease) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}

export class InMemoryExecutionLock implements ExecutionLock {
  private activeToken: symbol | null = null;
  private readonly waiters: LockWaiter[] = [];

  acquire(owner: string, signal: AbortSignal): Promise<ExecutionLease> {
    if (owner.trim().length === 0) return Promise.reject(new TypeError('owner must not be blank'));
    if (signal.aborted) return Promise.reject(abortError());
    if (this.activeToken === null) return Promise.resolve(this.createLease(owner));

    return new Promise((resolve, reject) => {
      let waiter: LockWaiter;
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError());
      };
      waiter = { owner, signal, resolve, reject, onAbort };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  isLocked(): boolean {
    return this.activeToken !== null;
  }

  private createLease(owner: string): ExecutionLease {
    const token = Symbol(owner);
    this.activeToken = token;
    let released = false;
    return Object.freeze({
      owner,
      release: (): void => {
        if (released) return;
        released = true;
        if (this.activeToken !== token) return;
        this.activeToken = null;
        this.grantNext();
      },
    });
  }

  private grantNext(): void {
    while (this.activeToken === null) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) continue;
      waiter.resolve(this.createLease(waiter.owner));
    }
  }
}

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError');
}
