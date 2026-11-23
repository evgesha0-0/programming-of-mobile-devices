export type MotorState = 'stopped' | 'starting' | 'running' | 'stopping' | 'jammed';

export interface MotorPort {
  getState(): MotorState;
  start(signal: AbortSignal): Promise<void>;
  stop(signal: AbortSignal): Promise<void>;
  emergencyStop(): void;
}
