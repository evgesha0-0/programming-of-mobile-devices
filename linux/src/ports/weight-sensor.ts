export interface WeightSensorPort {
  tare(signal: AbortSignal): Promise<void>;
  readGrams(signal: AbortSignal): Promise<number>;
}
