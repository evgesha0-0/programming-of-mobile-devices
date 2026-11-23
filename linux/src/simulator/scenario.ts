export type SensorFault = 'none' | 'timeout' | 'disconnected';
export type SimulatorScenarioName =
  | 'normal'
  | 'underfeed'
  | 'overfeed'
  | 'motor-jam'
  | 'sensor-timeout'
  | 'sensor-disconnect';

export interface SimulatorScenario {
  readonly name: SimulatorScenarioName;
  readonly flowRateGramsPerSecond: number;
  readonly deliveryMultiplier: number;
  readonly motorStartDelayMs: number;
  readonly motorStopDelayMs: number;
  readonly inertiaGrams: number;
  readonly motorJamAfterGrams: number | null;
  readonly sensorFault: SensorFault;
  readonly sensorReadDelayMs: number;
  readonly sensorTimeoutMs: number;
  readonly sensorNoiseStdDevGrams: number;
  readonly sensorQuantizationGrams: number;
}

const normalScenario: SimulatorScenario = Object.freeze({
  name: 'normal',
  flowRateGramsPerSecond: 10,
  deliveryMultiplier: 1,
  motorStartDelayMs: 200,
  motorStopDelayMs: 150,
  inertiaGrams: 0.8,
  motorJamAfterGrams: null,
  sensorFault: 'none',
  sensorReadDelayMs: 50,
  sensorTimeoutMs: 5_000,
  sensorNoiseStdDevGrams: 0.05,
  sensorQuantizationGrams: 0.05,
});

const scenarios: Readonly<Record<SimulatorScenarioName, SimulatorScenario>> = Object.freeze({
  normal: normalScenario,
  underfeed: Object.freeze({
    ...normalScenario,
    name: 'underfeed',
    deliveryMultiplier: 0.55,
  }),
  overfeed: Object.freeze({
    ...normalScenario,
    name: 'overfeed',
    deliveryMultiplier: 1.35,
    inertiaGrams: 1.6,
  }),
  'motor-jam': Object.freeze({
    ...normalScenario,
    name: 'motor-jam',
    motorJamAfterGrams: 5,
  }),
  'sensor-timeout': Object.freeze({
    ...normalScenario,
    name: 'sensor-timeout',
    sensorFault: 'timeout',
  }),
  'sensor-disconnect': Object.freeze({
    ...normalScenario,
    name: 'sensor-disconnect',
    sensorFault: 'disconnected',
  }),
});

export function getSimulatorScenario(name: SimulatorScenarioName): SimulatorScenario {
  return scenarios[name];
}

export function isSimulatorScenarioName(value: string): value is SimulatorScenarioName {
  return Object.hasOwn(scenarios, value);
}
