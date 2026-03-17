import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { getMessagesSince, getNewMessages } from './db.js';
import { GroupQueue } from './group-queue.js';
import { groupNeedsTrigger, hasAllowedTrigger } from './message-gating.js';
import { findChannel, formatMessages } from './router.js';
import { loadSenderAllowlist } from './sender-allowlist.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

interface MessageLoopDeps {
  channels: Channel[];
  queue: GroupQueue;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getLastTimestamp: () => string;
  setLastTimestamp: (timestamp: string) => void;
  getLastAgentTimestamp: (chatJid: string) => string;
  setLastAgentTimestamp: (chatJid: string, timestamp: string) => void;
  saveState: () => void;
}

function groupMessagesByChat(messages: NewMessage[]): Map<string, NewMessage[]> {
  const grouped = new Map<string, NewMessage[]>();
  for (const message of messages) {
    const existing = grouped.get(message.chat_jid);
    if (existing) {
      existing.push(message);
    } else {
      grouped.set(message.chat_jid, [message]);
    }
  }
  return grouped;
}

function shouldSkipGroupMessages(
  chatJid: string,
  group: RegisteredGroup,
  groupMessages: NewMessage[],
): boolean {
  if (!groupNeedsTrigger(group)) return false;
  const allowlistCfg = loadSenderAllowlist();
  return !hasAllowedTrigger(chatJid, groupMessages, allowlistCfg);
}

function pipeOrEnqueueMessages(
  deps: MessageLoopDeps,
  chatJid: string,
  messagesToSend: NewMessage[],
): void {
  const formatted = formatMessages(messagesToSend, TIMEZONE);
  if (deps.queue.sendMessage(chatJid, formatted)) {
    logger.debug(
      { chatJid, count: messagesToSend.length },
      'Piped messages to active container',
    );
    deps.setLastAgentTimestamp(
      chatJid,
      messagesToSend[messagesToSend.length - 1].timestamp,
    );
    deps.saveState();
    deps.channels.find((channel) => channel.ownsJid(chatJid))?.setTyping?.(
      chatJid,
      true,
    );
    return;
  }

  deps.queue.enqueueMessageCheck(chatJid);
}

async function processPollingCycle(deps: MessageLoopDeps): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  const jids = Object.keys(registeredGroups);
  const { messages, newTimestamp } = getNewMessages(
    jids,
    deps.getLastTimestamp(),
    ASSISTANT_NAME,
  );

  if (messages.length === 0) return;

  logger.info({ count: messages.length }, 'New messages');
  deps.setLastTimestamp(newTimestamp);
  deps.saveState();

  const messagesByGroup = groupMessagesByChat(messages);
  for (const [chatJid, groupMessages] of messagesByGroup) {
    const group = registeredGroups[chatJid];
    if (!group) continue;

    const channel = findChannel(deps.channels, chatJid);
    if (!channel) {
      console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
      continue;
    }

    if (shouldSkipGroupMessages(chatJid, group, groupMessages)) continue;

    const allPending = getMessagesSince(
      chatJid,
      deps.getLastAgentTimestamp(chatJid),
      ASSISTANT_NAME,
    );
    const messagesToSend = allPending.length > 0 ? allPending : groupMessages;
    pipeOrEnqueueMessages(deps, chatJid, messagesToSend);
  }
}

export async function startMessageLoop(deps: MessageLoopDeps): Promise<void> {
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      await processPollingCycle(deps);
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

export function recoverPendingMessages(
  registeredGroups: Record<string, RegisteredGroup>,
  getLastAgentTimestamp: (chatJid: string) => string,
  queue: GroupQueue,
): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getLastAgentTimestamp(chatJid),
      ASSISTANT_NAME,
    );
    if (pending.length === 0) continue;

    logger.info(
      { group: group.name, pendingCount: pending.length },
      'Recovery: found unprocessed messages',
    );
    queue.enqueueMessageCheck(chatJid);
  }
}
