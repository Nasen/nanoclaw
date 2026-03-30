import { getAgentBackendConfig } from './agent-backend.js';
import { deleteSession } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { formatMessages } from './router.js';
import { isTriggerAllowed } from './sender-allowlist.js';
import type { NewMessage } from './types.js';

const HOST_RESET_COMMAND = '/reset';
const NATIVE_ONLY_COMMANDS = new Set(['/clear', '/compact']);

export interface ParsedSlashCommand {
  raw: string;
  command: string;
  args: string;
}

export interface ChatTurnInput {
  text: string;
  mode: 'formatted' | 'raw';
  slashCommand?: ParsedSlashCommand;
}

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const raw = text.trim();
  if (!raw.startsWith('/')) return null;

  const [commandToken, ...argTokens] = raw.split(/\s+/);
  return {
    raw,
    command: commandToken.toLowerCase(),
    args: argTokens.join(' '),
  };
}

export function parseStandaloneSlashCommand(
  messages: NewMessage[],
): ParsedSlashCommand | null {
  if (messages.length !== 1) return null;
  return parseSlashCommand(messages[0].content);
}

export function buildChatTurnInput(
  messages: NewMessage[],
  timezone: string,
): ChatTurnInput {
  const slashCommand = parseStandaloneSlashCommand(messages);
  if (slashCommand) {
    return {
      text: slashCommand.raw,
      mode: 'raw',
      slashCommand,
    };
  }

  return {
    text: formatMessages(messages, timezone),
    mode: 'formatted',
  };
}

export function hasAllowedStandaloneSlashCommand(
  chatJid: string,
  messages: NewMessage[],
  allowlistCfg: ReturnType<
    typeof import('./sender-allowlist.js').loadSenderAllowlist
  >,
): boolean {
  const slashCommand = parseStandaloneSlashCommand(messages);
  if (!slashCommand) return false;

  const [message] = messages;
  return (
    !!message.is_from_me ||
    isTriggerAllowed(chatJid, message.sender, allowlistCfg)
  );
}

export function supportsNativeSlashCommand(command: string): boolean {
  const { backend } = getAgentBackendConfig();
  return backend === 'claude' && NATIVE_ONLY_COMMANDS.has(command);
}

export function getSlashCommandBackendName(): string {
  return getAgentBackendConfig().backend;
}

export async function handleReservedSlashCommand(params: {
  slashCommand: ParsedSlashCommand;
  chatJid: string;
  groupFolder: string;
  queue: GroupQueue;
  sendMessage: (text: string) => Promise<void>;
}): Promise<boolean> {
  const { slashCommand, chatJid, groupFolder, queue, sendMessage } = params;

  if (slashCommand.command === HOST_RESET_COMMAND) {
    logger.info(
      { chatJid, groupFolder },
      'Resetting chat session via slash command',
    );
    deleteSession(groupFolder);
    queue.resetChatSession(chatJid);
    await sendMessage(
      'Session reset. The next message starts a fresh session.',
    );
    return true;
  }

  if (NATIVE_ONLY_COMMANDS.has(slashCommand.command)) {
    if (supportsNativeSlashCommand(slashCommand.command)) {
      return false;
    }

    const backend = getSlashCommandBackendName();
    await sendMessage(
      `${slashCommand.command} is not supported by the current ${backend} backend.`,
    );
    return true;
  }

  return false;
}
