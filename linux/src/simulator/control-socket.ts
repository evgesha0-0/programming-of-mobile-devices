import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

import {
  parseSimulatorControlCommand,
  SimulatorController,
  type SimulatorControlCommand,
  type SimulatorControlResult,
} from './simulator-controller.js';

const maximumMessageBytes = 8_192;

export class SimulatorControlServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly controller: SimulatorController,
    readonly socketPath: string,
  ) {
    if (socketPath.trim().length === 0) throw new TypeError('socketPath must not be blank');
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('Simulator control server is already started');
    prepareSocketPath(this.socketPath);
    const server = createServer((socket) => this.handleSocket(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.socketPath);
      });
      if (process.platform !== 'win32') chmodSync(this.socketPath, 0o600);
    } catch (error) {
      this.server = null;
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      removeSocketPath(this.socketPath);
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeSocketPath(this.socketPath);
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let processing = Promise.resolve();
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > maximumMessageBytes) {
        socket.destroy(new Error('Simulator control message is too large'));
        return;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        processing = processing.then(() => this.processLine(socket, line));
      }
    });
    socket.once('close', () => this.sockets.delete(socket));
    socket.once('error', () => this.sockets.delete(socket));
  }

  private async processLine(socket: Socket, line: string): Promise<void> {
    try {
      const command = parseSimulatorControlCommand(JSON.parse(line) as unknown);
      const result = await this.controller.execute(command);
      socket.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({
        ok: false,
        error: {
          code: error instanceof SyntaxError ? 'INVALID_JSON' : 'INVALID_COMMAND',
          message: error instanceof TypeError ? error.message : 'Simulator command failed',
        },
      })}\n`);
    }
  }
}

export async function sendSimulatorControlCommand(
  socketPath: string,
  command: SimulatorControlCommand,
  timeoutMs = 5_000,
): Promise<SimulatorControlResult> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs);
    let buffer = '';
    let settled = false;
    const finish = (error?: unknown, result?: SimulatorControlResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error !== undefined) reject(error);
      else if (result) resolve(result);
      else reject(new Error('Simulator control returned no result'));
    };
    socket.once('connect', () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > maximumMessageBytes) {
        finish(new Error('Simulator control response is too large'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as {
          ok?: boolean;
          error?: { message?: string };
        } & Partial<SimulatorControlResult>;
        if (response.ok !== true) {
          finish(new Error(response.error?.message ?? 'Simulator control command failed'));
          return;
        }
        finish(undefined, response as SimulatorControlResult);
      } catch (error) {
        finish(error);
      }
    });
    socket.once('timeout', () => finish(new Error('Simulator control request timed out')));
    socket.once('error', (error) => finish(error));
  });
}

function prepareSocketPath(socketPath: string): void {
  if (process.platform === 'win32' && socketPath.startsWith('\\\\.\\pipe\\')) return;
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    const existing = lstatSync(socketPath);
    if (!existing.isSocket()) throw new Error('Simulator socket path exists and is not a socket');
    unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function removeSocketPath(socketPath: string): void {
  if (process.platform === 'win32' && socketPath.startsWith('\\\\.\\pipe\\')) return;
  try {
    unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
