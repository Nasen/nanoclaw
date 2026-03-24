const LEGACY_TOOL_REFUSAL_PATTERNS = [
  /does not support NanoClaw tool execution yet/i,
  /tools? are unavailable/i,
];

const RC_STALE_HISTORY_PATTERNS = [
  /couldn.?t find a readable rc chat source/i,
  /can.?t access (?:the )?(?:latest )?(?:live )?(?:message|messages).*(?:ringcentral|rc|team)/i,
  /no accessible ringcentral feed/i,
  /don.?t currently have direct access to .*ringcentral/i,
  /latest message.*not available from the workspace data/i,
];

const SEND_ON_BEHALF_STALE_PATTERNS = [
  /can.?t directly send messages? using your personal account/i,
  /can.?t actually send a message using your personal account/i,
  /don.?t have a “send as user” tool/i,
  /can.?t directly send a personal message on your behalf/i,
];

export function containsLegacyToolRefusal(text: string): boolean {
  return LEGACY_TOOL_REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
}

export function shouldDropAssistantHistory(
  text: string,
  options: {
    rcChat: boolean;
    personalMode: boolean;
  },
): boolean {
  if (containsLegacyToolRefusal(text)) return true;
  if (
    options.rcChat &&
    RC_STALE_HISTORY_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return true;
  }
  if (
    options.personalMode &&
    SEND_ON_BEHALF_STALE_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return true;
  }
  return false;
}

function normalizeComparableText(text: string): string {
  return text
    .replace(/<internal>[\s\S]*?<\/internal>/gi, ' ')
    .replace(/[`*_>#~[\]()"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokenizeComparableText(text: string): string[] {
  return normalizeComparableText(text)
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 3);
}

export function buildTurnMessageDeduplicationKey(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const text =
    typeof args.text === 'string' ? normalizeComparableText(args.text) : '';
  if (!text) return null;

  if (toolName === 'send_message') {
    const sender =
      typeof args.sender === 'string'
        ? normalizeComparableText(args.sender)
        : '';
    const deliveryMode =
      typeof args.delivery_mode === 'string' ? args.delivery_mode : 'auto';
    return [toolName, deliveryMode, sender, text].join('|');
  }

  if (toolName === 'send_rc_message') {
    const chatId =
      typeof args.chat_id === 'string' ? args.chat_id.trim().toLowerCase() : '';
    if (!chatId) return null;
    const mode = typeof args.mode === 'string' ? args.mode : 'auto';
    return [toolName, chatId, mode, text].join('|');
  }

  return null;
}

export function messagesSubstantiallyOverlap(
  a: string,
  b: string,
): boolean {
  const left = normalizeComparableText(a);
  const right = normalizeComparableText(b);
  if (!left || !right) return false;
  if (left === right) return true;

  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.length >= 80 && longer.includes(shorter)) return true;

  const shorterTokens = tokenizeComparableText(shorter);
  if (shorterTokens.length < 8) return false;
  const longerTokenSet = new Set(tokenizeComparableText(longer));
  const overlapCount = shorterTokens.filter((token) =>
    longerTokenSet.has(token),
  ).length;

  return overlapCount / shorterTokens.length >= 0.85;
}

export function isSendConfirmation(text: string): boolean {
  const normalized = normalizeComparableText(text);
  if (!normalized) return false;
  return /^(i )?(sent|posted|replied|told|shared|forwarded)\b/.test(
    normalized,
  );
}

export function chooseFinalAssistantOutput(
  finalText: string,
  sentMessages: string[],
): {
  outputText: string;
  historyText: string;
} {
  const trimmedFinal = finalText.trim();
  const deliveredText = [...sentMessages]
    .reverse()
    .find((message) => message.trim().length > 0);

  if (!deliveredText) {
    return {
      outputText: trimmedFinal,
      historyText: trimmedFinal,
    };
  }

  if (!trimmedFinal) {
    return {
      outputText: '',
      historyText: deliveredText,
    };
  }

  const duplicatesDeliveredMessage = sentMessages.some((message) =>
    messagesSubstantiallyOverlap(trimmedFinal, message),
  );
  if (duplicatesDeliveredMessage || isSendConfirmation(trimmedFinal)) {
    return {
      outputText: '',
      historyText: deliveredText,
    };
  }

  return {
    outputText: trimmedFinal,
    historyText: trimmedFinal,
  };
}
