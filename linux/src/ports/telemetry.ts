export type TelemetryFields = Readonly<Record<string, string | number | boolean | null>>;

export interface Telemetry {
  event(name: string, fields?: TelemetryFields): void;
  increment(name: string, value?: number, fields?: TelemetryFields): void;
  gauge(name: string, value: number, fields?: TelemetryFields): void;
}
