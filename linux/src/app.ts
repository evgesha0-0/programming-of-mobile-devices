export const serviceMetadata = Object.freeze({
  name: 'smart-cat-feeder-linux',
  version: '0.1.0',
  hardwareAdapter: 'simulator',
} as const);

export interface StartupEvent {
  event: 'scaffold_ready';
  service: typeof serviceMetadata.name;
  version: typeof serviceMetadata.version;
  hardware_adapter: typeof serviceMetadata.hardwareAdapter;
}

export function createStartupEvent(): StartupEvent {
  return {
    event: 'scaffold_ready',
    service: serviceMetadata.name,
    version: serviceMetadata.version,
    hardware_adapter: serviceMetadata.hardwareAdapter,
  };
}
