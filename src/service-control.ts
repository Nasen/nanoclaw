import { isMainGroup } from './group-access.js';
import { RegisteredGroup } from './types.js';

const SERVICE_TOGGLE_PATTERN =
  /^\s*(enable|disable|turn\s+on|turn\s+off)\s+(service|nanoclaw)\s*$/i;

export function parseServiceToggleCommand(text: string): boolean | null {
  const match = text.match(SERVICE_TOGGLE_PATTERN);
  if (!match) return null;
  return /enable|turn\s+on/i.test(match[1]);
}

export function isAdminServiceControlGroup(
  group: RegisteredGroup | undefined,
): boolean {
  if (!group) return false;
  return isMainGroup(group);
}

export function buildServiceToggleConfirmation(
  enabled: boolean,
  changed: boolean,
): string {
  if (enabled) {
    return changed
      ? 'Service enabled. NanoClaw will process new messages and scheduled tasks again.'
      : 'Service is already enabled.';
  }

  return changed
    ? 'Service disabled. NanoClaw will not respond to messages, and active or queued work is being stopped.'
    : 'Service is already disabled.';
}

export function buildUnauthorizedServiceControlMessage(): string {
  return 'Service control is only available in admin chats.';
}
