import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

import { LocalStoreLockedError } from '../../ports/index.js';

interface LockRecord {
  pid: number;
  token: string;
  createdAt: string;
}

export class ProcessLock {
  static acquire(path: string): ProcessLock {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      try {
        const descriptor = openSync(path, 'wx', 0o600);
        try {
          const record: LockRecord = {
            pid: process.pid,
            token,
            createdAt: new Date().toISOString(),
          };
          writeFileSync(descriptor, JSON.stringify(record), 'utf8');
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        return new ProcessLock(path, token);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        const existing = readLockRecord(path);
        if (existing === null || isProcessAlive(existing.pid)) {
          throw new LocalStoreLockedError(path);
        }
        unlinkSync(path);
      }
    }

    throw new LocalStoreLockedError(path);
  }

  private released = false;

  private constructor(
    private readonly path: string,
    private readonly token: string,
  ) {}

  release(): void {
    if (this.released) return;
    this.released = true;

    const existing = readLockRecord(this.path);
    if (existing?.token !== this.token) return;

    try {
      unlinkSync(this.path);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
}

function readLockRecord(path: string): LockRecord | null {
  try {
    const candidate: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof candidate !== 'object'
      || candidate === null
      || !('pid' in candidate)
      || !('token' in candidate)
      || !('createdAt' in candidate)
      || !Number.isSafeInteger(candidate.pid)
      || typeof candidate.token !== 'string'
      || typeof candidate.createdAt !== 'string'
    ) {
      return null;
    }
    return {
      pid: candidate.pid as number,
      token: candidate.token,
      createdAt: candidate.createdAt,
    };
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
