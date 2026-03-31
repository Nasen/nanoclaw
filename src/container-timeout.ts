import { CONTAINER_TIMEOUT } from './config.js';
import { RegisteredGroup } from './types.js';

const DEFAULT_RC_PERSONAL_CONTAINER_TIMEOUT_MS = 4 * 60 * 1000;

export function resolveContainerTimeoutMs(group: RegisteredGroup): number {
  if (group.containerConfig?.timeout) {
    return group.containerConfig.timeout;
  }

  if (group.folder === 'rc-personal') {
    return DEFAULT_RC_PERSONAL_CONTAINER_TIMEOUT_MS;
  }

  return CONTAINER_TIMEOUT;
}
