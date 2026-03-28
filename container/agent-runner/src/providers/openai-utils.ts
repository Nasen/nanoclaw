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
  /request rate exceeded/i,
  /rc(?:_| )list(?:_| )chats timed out/i,
  /mcp tool list_rc_chats failed:.*request timed out/i,
  /ringcentral chat lookup hit rate limits/i,
  /couldn.?t locate that exact team chat right now/i,
  /unable to complete this rc lookup/i,
  /couldn.?t retrieve .*ringcentral lookup timed out/i,
  /couldn.?t retrieve .*conversation .*timed out/i,
  /current tool environment/i,
  /no recent messages?.*available in that chat/i,
  /no readable messages?.*available ringcentral history/i,
  /recipient resolution didn.?t match .*personal auth context/i,
  /ringcentral resolved the request to a different auth context/i,
];

const SEND_ON_BEHALF_STALE_PATTERNS = [
  /can.?t directly send messages? using your personal account/i,
  /can.?t actually send a message using your personal account/i,
  /don.?t have a “send as user” tool/i,
  /can.?t directly send a personal message on your behalf/i,
];

const THIRD_PARTY_MCP_STALE_PATTERNS = [
  /don.?t have (?:a|any).*(?:jira|gitlab|atlassian|gmail|figma|m365|outlook).*(?:mcp|tool)/i,
  /(?:jira|gitlab|atlassian|gmail|figma|m365|outlook).*(?:mcp|tool).*(?:not currently|not available|unavailable)/i,
  /don.?t have .*specific mcp tools exposed here/i,
  /dedicated (?:jira|gitlab|atlassian|gmail|figma|m365).*(?:connector|tool).*(?:not currently|unavailable)/i,
  /don.?t have a direct .*gitlab.*(?:api )?tool available in this session/i,
  /don.?t have a direct .*jira.*(?:api )?tool available in this session/i,
];

const MCP_SERVER_LABELS: Record<string, string> = {
  atlassian: 'Jira/Atlassian',
  figma: 'Figma',
  gitlab: 'GitLab',
  gmail: 'Gmail',
  m365: 'M365',
  nanoclaw: 'NanoClaw',
};

const EXPLICIT_ON_BEHALF_REQUEST_PATTERN =
  /\b(on my behalf|on behalf of me|as me|reply as me|send as me|speak as me|use my personal (?:rc|ringcentral|account|credentials)|use my account|using my account|use my credentials|using my credentials|use personal credentials|from my account|via my account|via my personal rc|as nasen)\b/i;

export function containsLegacyToolRefusal(text: string): boolean {
  return LEGACY_TOOL_REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
}

export function containsThirdPartyMcpRefusal(text: string): boolean {
  return THIRD_PARTY_MCP_STALE_PATTERNS.some((pattern) => pattern.test(text));
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
  if (
    options.personalMode &&
    THIRD_PARTY_MCP_STALE_PATTERNS.some((pattern) => pattern.test(text))
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

  if (toolName === 'send_rc_message' || toolName === 'send_rc_dm') {
    const chatId =
      typeof args.chat_id === 'string'
        ? args.chat_id.trim().toLowerCase()
        : typeof args.person === 'string'
          ? args.person.trim().toLowerCase()
          : '';
    if (!chatId) return null;
    const mode = typeof args.mode === 'string' ? args.mode : 'auto';
    return [toolName, chatId, mode, text].join('|');
  }

  return null;
}

export function hasExplicitOnBehalfRequest(prompt: string): boolean {
  return EXPLICIT_ON_BEHALF_REQUEST_PATTERN.test(prompt);
}

export function extractJiraIssueKey(prompt: string): string | null {
  const match = prompt.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return match ? match[1].toUpperCase() : null;
}

export function isDirectJiraIssueLookupRequest(prompt: string): boolean {
  const issueKey = extractJiraIssueKey(prompt);
  if (!issueKey) return false;

  const normalized = prompt.toLowerCase();
  return /\b(jira|ticket|issue|bug|story|task)\b/.test(normalized);
}

export function normalizeSendToolArgsForPrompt(
  toolName: string,
  args: Record<string, unknown>,
  prompt: string,
): Record<string, unknown> {
  if (
    toolName !== 'send_message' &&
    toolName !== 'send_rc_message' &&
    toolName !== 'send_rc_dm'
  ) {
    return args;
  }

  if (!hasExplicitOnBehalfRequest(prompt)) return args;
  if (args.on_behalf_intent === true) return args;

  return {
    ...args,
    on_behalf_intent: true,
  };
}

export function buildMcpConnectionFailureMessage(
  connectionErrors: Array<{
    serverName: string;
    error: string;
  }>,
): string | null {
  const uniqueFailures = Array.from(
    new Map(
      connectionErrors
        .map(({ serverName, error }) => [serverName, error.trim()] as const)
        .filter(
          ([serverName, error]) => serverName !== 'nanoclaw' && error.length > 0,
        ),
    ).entries(),
  );

  if (uniqueFailures.length === 0) return null;

  const formatted = uniqueFailures.map(
    ([serverName, error]) =>
      `${MCP_SERVER_LABELS[serverName] || serverName} (${error})`,
  );

  if (formatted.length === 1) {
    return `I couldn't complete that because the required connector failed to initialize: ${formatted[0]}.`;
  }

  return `I couldn't complete that because required connectors failed to initialize: ${formatted.join('; ')}.`;
}

export function messagesSubstantiallyOverlap(a: string, b: string): boolean {
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
  return /^(i )?(sent|posted|replied|told|shared|forwarded)\b/.test(normalized);
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
