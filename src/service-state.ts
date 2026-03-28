let serviceEnabled = true;
let serviceStateVersion = 0;

export function initializeServiceState(enabled: boolean): void {
  serviceEnabled = enabled;
  serviceStateVersion = 0;
}

export function isServiceEnabled(): boolean {
  return serviceEnabled;
}

export function getServiceStateVersion(): number {
  return serviceStateVersion;
}

export function setRuntimeServiceEnabled(enabled: boolean): boolean {
  if (serviceEnabled === enabled) return false;
  serviceEnabled = enabled;
  serviceStateVersion++;
  return true;
}

/** @internal - for tests only. */
export function _resetServiceStateForTests(): void {
  initializeServiceState(true);
}
