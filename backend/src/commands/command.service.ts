import { randomUUID } from 'node:crypto';

import { ConflictError, NotFoundError } from '../utils/http-error.js';
import type { CommandRepository } from './command.repository.js';
import type { ManualCommandRecord } from './command.types.js';

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

export interface CommandService {
  create(
    deviceId: string,
    input: CreateManualCommandInput,
  ): Promise<CreateManualCommandResponse>;
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

class InvalidExpiryError extends Error {
  readonly validation = [{ instancePath: '/expires_at', message: 'must be in the future' }];

  constructor() {
    super('Поле expires_at должно быть позже времени создания команды');
  }
}

