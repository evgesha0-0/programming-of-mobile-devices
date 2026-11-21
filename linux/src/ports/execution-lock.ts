export interface ExecutionLease {
  readonly owner: string;
  release(): void;
}

export interface ExecutionLock {
  acquire(owner: string, signal: AbortSignal): Promise<ExecutionLease>;
  isLocked(): boolean;
}
