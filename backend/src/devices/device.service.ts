import type { DeviceRepository } from './device.repository.js';
import type { DeviceStateRecord, DeviceStateUpdate } from './device.types.js';
import { ConflictError, NotFoundError } from '../utils/http-error.js';

interface LastErrorResponse {
  code: string | null;
  message: string | null;
}

export interface DeviceStateResponse {
  device_id: string;
  status: DeviceStateRecord['status'];
  last_seen_at: string | null;
  last_error: LastErrorResponse | null;
  schedule_revision: number;
}

export interface ReportDeviceStateInput {
  status: DeviceStateUpdate['status'];
  reported_at: string;
  firmware_version: string;
  error_code: string | null;
  error_message: string | null;
}

export interface ReportDeviceStateResponse {
  device_id: string;
  status: DeviceStateRecord['status'];
  last_seen_at: string;
  server_time: string;
}

export interface DeviceService {
  getState(deviceId: string): Promise<DeviceStateResponse>;
  reportState(deviceId: string, input: ReportDeviceStateInput): Promise<ReportDeviceStateResponse>;
}

export function createDeviceService(repository: DeviceRepository): DeviceService {
  return {
    async getState(deviceId) {
      const state = await requireState(repository, deviceId);
      return toStateResponse(state);
    },

    async reportState(deviceId, input) {
      const update: DeviceStateUpdate = {
        status: input.status,
        reportedAt: new Date(input.reported_at),
        firmwareVersion: input.firmware_version,
        errorCode: input.error_code,
        errorMessage: input.error_message,
      };
      const updated = await repository.updateStateIfNewer(deviceId, update);

      if (updated) {
        return {
          device_id: updated.deviceId,
          status: updated.status,
          last_seen_at: requireLastSeenAt(updated).toISOString(),
          server_time: updated.serverTime.toISOString(),
        };
      }

      const current = await requireState(repository, deviceId);
      if (isExactRepeat(current, update)) {
        return {
          device_id: current.deviceId,
          status: current.status,
          last_seen_at: requireLastSeenAt(current).toISOString(),
          server_time: new Date().toISOString(),
        };
      }

      throw new ConflictError('Состояние устройства устарело или конфликтует с уже принятым');
    },
  };
}

async function requireState(repository: DeviceRepository, deviceId: string): Promise<DeviceStateRecord> {
  const state = await repository.findState(deviceId);
  if (!state) throw new NotFoundError('Устройство не найдено');
  return state;
}

function toStateResponse(state: DeviceStateRecord): DeviceStateResponse {
  const revision = Number(state.scheduleRevision);
  if (!Number.isSafeInteger(revision)) throw new Error('Schedule revision exceeds JSON integer range');

  const lastError = state.lastErrorCode === null && state.lastErrorMessage === null
    ? null
    : { code: state.lastErrorCode, message: state.lastErrorMessage };

  return {
    device_id: state.deviceId,
    status: state.status,
    last_seen_at: state.lastSeenAt?.toISOString() ?? null,
    last_error: lastError,
    schedule_revision: revision,
  };
}

function isExactRepeat(state: DeviceStateRecord, update: DeviceStateUpdate): boolean {
  return state.lastSeenAt?.getTime() === update.reportedAt.getTime()
    && state.status === update.status
    && state.firmwareVersion === update.firmwareVersion
    && state.lastErrorCode === update.errorCode
    && state.lastErrorMessage === update.errorMessage;
}

function requireLastSeenAt(state: DeviceStateRecord): Date {
  if (!state.lastSeenAt) throw new Error('Updated device state has no last_seen_at');
  return state.lastSeenAt;
}

