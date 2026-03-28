import { RcDeliveryMode } from './types.js';

export interface RcDeliveryDecision {
  mode: Exclude<RcDeliveryMode, 'auto'> | 'auto';
  policyForced: boolean;
}

const ON_BEHALF_PATTERN =
  /\b(on my behalf|on behalf of me|as me|reply as me|send as me|speak as me|use my personal (?:rc|ringcentral|account|credentials)|use my credentials|using my credentials|use personal credentials|from my account|via my account|via my personal rc)\b/i;

export function isRingCentralChatJid(jid: string): boolean {
  return jid.startsWith('rc:') || jid.startsWith('rcb:');
}

export function hasExplicitOnBehalfIntent(text: string): boolean {
  return ON_BEHALF_PATTERN.test(text);
}

export function hasExplicitOnBehalfIntentInMessages(
  messages: Array<{ content: string; is_from_me?: boolean }>,
): boolean {
  const latestInbound = [...messages]
    .reverse()
    .find((message) => !message.is_from_me);
  if (!latestInbound) return false;
  return hasExplicitOnBehalfIntent(latestInbound.content);
}

export function resolveCurrentChatRcDelivery(params: {
  chatJid: string;
  requestedMode?: RcDeliveryMode;
  onBehalfIntent: boolean;
}): RcDeliveryDecision {
  const { chatJid, requestedMode, onBehalfIntent } = params;
  if (!isRingCentralChatJid(chatJid)) {
    return {
      mode: requestedMode || 'auto',
      policyForced: false,
    };
  }

  if (onBehalfIntent) {
    return {
      mode: 'personal',
      policyForced: requestedMode !== 'personal',
    };
  }

  if (requestedMode === 'personal' || requestedMode === 'bot') {
    return {
      mode: requestedMode,
      policyForced: false,
    };
  }

  return {
    mode: 'bot',
    policyForced: true,
  };
}

export function resolveCrossChatRcDelivery(params: {
  requestedMode?: RcDeliveryMode;
  onBehalfIntent: boolean;
}): RcDeliveryDecision {
  const { requestedMode, onBehalfIntent } = params;
  if (onBehalfIntent) {
    return {
      mode: 'personal',
      policyForced: requestedMode !== 'personal',
    };
  }

  if (requestedMode === 'personal' || requestedMode === 'bot') {
    return {
      mode: requestedMode,
      policyForced: false,
    };
  }

  return {
    mode: 'bot',
    policyForced: true,
  };
}
