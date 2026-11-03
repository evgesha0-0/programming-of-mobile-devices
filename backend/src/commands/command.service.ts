import { randomUUID } from 'node:crypto';

import { ConflictError, NotFoundError } from '../utils/http-error.js';
import type { CommandRepository } from './command.repository.js';
import type { ManualCommandRecord, PendingCommandRecord } from './command.types.js';

export interface CreateManualCommandInput {
  command_id: string;
  portion_grams: number;
  expires_at: string;
}

export interface ManualCommandResponse {
  command_id: string;
  feeding_id: string;
  device_id: string;
  source: 'manual';
  portion_grams: number;
  status: ManualCommandRecord['status'];
  created_at: string;
  expires_at: string;
  started_at: string | null;
  finished_at: string | null;
  actual_grams: number | null;
  error_code: string | null;
}

export interface CreateManualCommandResponse {
  created: boolean;
  command: ManualCommandResponse;
}

export interface PendingCommandResponse {
  command_id: string;
  feeding_id: string;
  device_id: string;
  portion_grams: number;
  status: 'pending';
  created_at: string;
  expires_at: string;
}

export interface PendingCommandListResponse {
  items: PendingCommandResponse[];
  server_time: string;
}

export interface AcknowledgeCommandInput {
  feeding_id: string;
  status: 'running';
  started_at: string;
}

export interface AcknowledgeCommandResponse {
  command_id: string;
  feeding_id: string;
  status: 'running';
  started_at: string;
}

export interface CommandService {
  create(
    deviceId: string,
    input: CreateManualCommandInput,
  ): Promise<CreateManualCommandResponse>;
  listPending(deviceId: string, limit: number): Promise<PendingCommandListResponse>;
  acknowledge(
    deviceId: string,
    commandId: string,
    input: AcknowledgeCommandInput,
  ): Promise<AcknowledgeCommandResponse>;
}

export function createCommandService(
  repository: CommandRepository,
  now: () => Date = () => new Date(),
): CommandService {
  return {
    async create(deviceId, input) {
      const createdAt = now();
      const expiresAt = new Date(input.expires_at);

      const result = await repository.create({
        commandId: input.command_id,
        feedingId: randomUUID(),
        deviceId,
        portionGrams: input.portion_grams,
        createdAt,
        expiresAt,
      });

      if (result.kind === 'device_not_found') throw new NotFoundError('Устройство не найдено');
      if (result.kind === 'invalid_expiry') throw new InvalidExpiryError();
      if (result.kind === 'conflict') {
        throw new ConflictError('command_id уже используется для другой команды');
      }

      return {
        created: result.kind === 'created',
        command: toResponse(result.command),
      };
    },

    async listPending(deviceId, limit) {
      const result = await repository.listPending(deviceId, limit);
      if (result.kind === 'device_not_found') throw new NotFoundError('Устройство не найдено');
      return {
        items: result.commands.items.map(toPendingResponse),
        server_time: result.commands.serverTime.toISOString(),
      };
    },

    async acknowledge(deviceId, commandId, input) {
      const result = await repository.acknowledge({
        deviceId,
        commandId,
        feedingId: input.feeding_id,
        startedAt: new Date(input.started_at),
      });
      if (result.kind === 'not_found') throw new NotFoundError('Команда не найдена');
      if (result.kind === 'conflict') {
        throw new ConflictError('Команда не может быть подтверждена в текущем состоянии');
      }
      if (result.kind === 'invalid_started_at') throw new InvalidStartedAtError();
      return {
        command_id: result.command.commandId,
        feeding_id: result.command.feedingId,
        status: result.command.status,
        started_at: result.command.startedAt.toISOString(),
      };
    },
  };
}

function toResponse(command: ManualCommandRecord): ManualCommandResponse {
  return {
    command_id: command.commandId,
    feeding_id: command.feedingId,
    device_id: command.deviceId,
    source: 'manual',
    portion_grams: Number(command.portionGrams),
    status: command.status,
    created_at: command.createdAt.toISOString(),
    expires_at: command.expiresAt.toISOString(),
    started_at: command.startedAt?.toISOString() ?? null,
    finished_at: command.finishedAt?.toISOString() ?? null,
    actual_grams: command.actualGrams === null ? null : Number(command.actualGrams),
    error_code: command.errorCode,
  };
}

function toPendingResponse(command: PendingCommandRecord): PendingCommandResponse {
  return {
    command_id: command.commandId,
    feeding_id: command.feedingId,
    device_id: command.deviceId,
    portion_grams: Number(command.portionGrams),
    status: command.status,
    created_at: command.createdAt.toISOString(),
    expires_at: command.expiresAt.toISOString(),
  };
}

class InvalidExpiryError extends Error {
  readonly validation = [{ instancePath: '/expires_at', message: 'must be in the future' }];

  constructor() {
    super('Поле expires_at должно быть позже времени создания команды');
  }
}

class InvalidStartedAtError extends Error {
  readonly validation = [{ instancePath: '/started_at', message: 'must not precede command creation' }];

  constructor() {
    super('Поле started_at не может быть раньше времени создания команды');
  }
}

