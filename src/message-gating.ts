import { TRIGGER_PATTERN } from './config.js';
import { isMainGroup, isPersonalModeGroup } from './group-access.js';
import { isTriggerAllowed } from './sender-allowlist.js';
import { NewMessage, RegisteredGroup } from './types.js';

export function groupNeedsTrigger(group: RegisteredGroup): boolean {
  return !isMainGroup(group) && group.requiresTrigger !== false;
}

export function hasAllowedTrigger(
  chatJid: string,
  messages: NewMessage[],
  allowlistCfg: ReturnType<
    typeof import('./sender-allowlist.js').loadSenderAllowlist
  >,
): boolean {
  return messages.some(
    (message) =>
      TRIGGER_PATTERN.test(message.content.trim()) &&
      (message.is_from_me ||
        isTriggerAllowed(chatJid, message.sender, allowlistCfg)),
  );
}

export function isPersonalRcDm(
  chatJid: string,
  group: RegisteredGroup,
): boolean {
  return chatJid.startsWith('rc:') && isPersonalModeGroup(group);
}
