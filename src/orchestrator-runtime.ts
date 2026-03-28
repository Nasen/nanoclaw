import { Server } from 'http';
import { ChildProcess } from 'child_process';

import {
  RcChatMember,
  RcChatSummary,
  RcChatTranscript,
  RcContact,
  RcContactInput,
  RcExtensionSummary,
  RcPhoneNumber,
  RcPresence,
  RcPresenceUpdateInput,
  RingCentralChannel,
} from './channels/ringcentral.js';
import { writeGroupsSnapshot } from './container-runner.js';
import { startIpcWatcher } from './ipc.js';
import { logger } from './logger.js';
import { addNotebookLmSources, createNotebookLmClient } from './notebooklm.js';
import { formatOutbound, resolveOutboundTarget } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, RcDeliveryMode, RegisteredGroup } from './types.js';
import { GroupQueue } from './group-queue.js';

type RegisteredGroupsGetter = () => Record<string, RegisteredGroup>;
type AvailableGroupsGetter =
  () => import('./container-runner.js').AvailableGroup[];

function getRcChannel(
  channels: Channel[],
  mode: RcDeliveryMode,
): RingCentralChannel {
  const targetName = mode === 'bot' ? 'rc-bot' : 'rc';
  const channel = channels.find(
    (candidate) =>
      candidate instanceof RingCentralChannel && candidate.name === targetName,
  );

  if (!(channel instanceof RingCentralChannel)) {
    throw new Error(`RingCentral channel "${targetName}" is not available`);
  }
  if (!channel.isConnected()) {
    throw new Error(`RingCentral channel "${targetName}" is not connected`);
  }

  return channel;
}

function getAlternateRcMode(mode: RcDeliveryMode): RcDeliveryMode | null {
  if (mode === 'personal') return 'bot';
  if (mode === 'bot') return 'personal';
  return null;
}

function shouldRetryRcOnAlternateChannel(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /request rate exceeded/i.test(message) ||
    /\b404\b/.test(message) ||
    /not found/i.test(message) ||
    /\b429\b/.test(message) ||
    /too many requests/i.test(message)
  );
}

export async function listRcChats(
  channels: Channel[],
  mode: RcDeliveryMode,
  query?: string,
  limit?: number,
): Promise<RcChatSummary[]> {
  try {
    return await getRcChannel(channels, mode).listChatsForAgent(query, limit);
  } catch (err) {
    const alternateMode = getAlternateRcMode(mode);
    if (!alternateMode || !shouldRetryRcOnAlternateChannel(err)) {
      throw err;
    }

    logger.warn(
      { mode, alternateMode, query, err },
      'RC list chats failed on primary channel, retrying on alternate channel',
    );
    return getRcChannel(channels, alternateMode).listChatsForAgent(
      query,
      limit,
    );
  }
}

export async function readRcMessages(
  channels: Channel[],
  chatRef: string,
  mode: RcDeliveryMode,
  limit?: number,
): Promise<RcChatTranscript> {
  try {
    return await getRcChannel(channels, mode).readMessagesForAgent(
      chatRef,
      limit,
    );
  } catch (err) {
    const alternateMode = getAlternateRcMode(mode);
    if (!alternateMode || !shouldRetryRcOnAlternateChannel(err)) {
      throw err;
    }

    logger.warn(
      { mode, alternateMode, chatRef, err },
      'RC read messages failed on primary channel, retrying on alternate channel',
    );
    return getRcChannel(channels, alternateMode).readMessagesForAgent(
      chatRef,
      limit,
    );
  }
}

export async function sendRcMessage(
  channels: Channel[],
  chatRef: string,
  text: string,
  mode: RcDeliveryMode,
): Promise<{ jid: string; chatId: string; postId?: string }> {
  return getRcChannel(channels, mode).sendMessageForAgent(chatRef, text);
}

export async function listRcChatMembers(
  channels: Channel[],
  chatRef: string,
  mode: RcDeliveryMode,
  limit?: number,
): Promise<RcChatMember[]> {
  return getRcChannel(channels, mode).listChatMembersForAgent(chatRef, limit);
}

export async function getRcPresence(
  channels: Channel[],
  mode: RcDeliveryMode,
  extensionId?: string,
): Promise<RcPresence> {
  return getRcChannel(channels, mode).getPresenceForAgent(extensionId);
}

export async function setRcPresence(
  channels: Channel[],
  mode: RcDeliveryMode,
  update: RcPresenceUpdateInput,
): Promise<RcPresence> {
  return getRcChannel(channels, mode).setPresenceForAgent(update);
}

export async function getRcExtension(
  channels: Channel[],
  mode: RcDeliveryMode,
  extensionId?: string,
): Promise<RcExtensionSummary> {
  return getRcChannel(channels, mode).getExtensionForAgent(extensionId);
}

export async function listRcExtensions(
  channels: Channel[],
  mode: RcDeliveryMode,
  query?: string,
  limit?: number,
): Promise<RcExtensionSummary[]> {
  return getRcChannel(channels, mode).listExtensionsForAgent(query, limit);
}

export async function listRcContacts(
  channels: Channel[],
  mode: RcDeliveryMode,
  query?: string,
  limit?: number,
): Promise<RcContact[]> {
  return getRcChannel(channels, mode).listContactsForAgent(query, limit);
}

export async function createRcContact(
  channels: Channel[],
  mode: RcDeliveryMode,
  contact: RcContactInput,
): Promise<RcContact> {
  return getRcChannel(channels, mode).createContactForAgent(contact);
}

export async function listRcPhoneNumbers(
  channels: Channel[],
  mode: RcDeliveryMode,
  limit?: number,
): Promise<RcPhoneNumber[]> {
  return getRcChannel(channels, mode).listPhoneNumbersForAgent(limit);
}

export async function sendFormattedMessage(
  channels: Channel[],
  jid: string,
  rawText: string,
  rcDeliveryMode: RcDeliveryMode = 'auto',
): Promise<void> {
  const target = resolveOutboundTarget(channels, jid, rcDeliveryMode);
  if (!target) {
    console.log(`Warning: no channel owns JID ${jid}, cannot send message`);
    return;
  }

  const text = formatOutbound(rawText);
  if (text) await target.channel.sendMessage(target.jid, text);
}

export async function sendChannelMessage(
  channels: Channel[],
  jid: string,
  text: string,
  rcDeliveryMode: RcDeliveryMode = 'auto',
): Promise<void> {
  const target = resolveOutboundTarget(channels, jid, rcDeliveryMode);
  if (!target) throw new Error(`No channel for JID: ${jid}`);
  await target.channel.sendMessage(target.jid, text);
}

export async function syncChannelGroups(
  channels: Channel[],
  force: boolean,
): Promise<void> {
  await Promise.all(
    channels
      .filter((channel) => channel.syncGroups)
      .map((channel) => channel.syncGroups!(force)),
  );
}

export function registerShutdownHandlers(
  proxyServer: Server,
  queue: GroupQueue,
  channels: Channel[],
): void {
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const channel of channels) await channel.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

interface StartSubsystemsOptions {
  channels: Channel[];
  queue: GroupQueue;
  registeredGroups: RegisteredGroupsGetter;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  getAvailableGroups: AvailableGroupsGetter;
  processGroupMessages: (chatJid: string) => Promise<boolean>;
  recoverPendingMessages: () => void;
  startMessageLoop: () => Promise<void>;
}

export function startSubsystems({
  channels,
  queue,
  registeredGroups,
  registerGroup,
  getAvailableGroups,
  processGroupMessages,
  recoverPendingMessages,
  startMessageLoop,
}: StartSubsystemsOptions): void {
  startSchedulerLoop({
    registeredGroups,
    queue,
    onProcess: (
      groupJid: string,
      proc: ChildProcess,
      containerName: string,
      groupFolder: string,
    ) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: (jid, rawText) => sendFormattedMessage(channels, jid, rawText),
  });

  startIpcWatcher({
    sendMessage: (jid, text, rcDeliveryMode) =>
      sendChannelMessage(channels, jid, text, rcDeliveryMode),
    registeredGroups,
    registerGroup,
    syncGroups: (force) => syncChannelGroups(channels, force),
    getAvailableGroups,
    rcListChats: (mode, query, limit) =>
      listRcChats(channels, mode, query, limit),
    rcReadMessages: (chatRef, mode, limit) =>
      readRcMessages(channels, chatRef, mode, limit),
    rcSendMessage: (chatRef, text, mode) =>
      sendRcMessage(channels, chatRef, text, mode),
    rcListChatMembers: (chatRef, mode, limit) =>
      listRcChatMembers(channels, chatRef, mode, limit),
    rcGetPresence: (mode, extensionId) =>
      getRcPresence(channels, mode, extensionId),
    rcSetPresence: (mode, update) => setRcPresence(channels, mode, update),
    rcGetExtension: (mode, extensionId) =>
      getRcExtension(channels, mode, extensionId),
    rcListExtensions: (mode, query, limit) =>
      listRcExtensions(channels, mode, query, limit),
    rcListContacts: (mode, query, limit) =>
      listRcContacts(channels, mode, query, limit),
    rcCreateContact: (mode, contact) =>
      createRcContact(channels, mode, contact),
    rcListPhoneNumbers: (mode, limit) =>
      listRcPhoneNumbers(channels, mode, limit),
    notebookLmListNotebooks: (limit) =>
      createNotebookLmClient().listNotebooks(limit),
    notebookLmCreateNotebook: (title) =>
      createNotebookLmClient().createNotebook(title),
    notebookLmGetNotebook: (notebookId) =>
      createNotebookLmClient().getNotebook(notebookId),
    notebookLmAddSources: (notebookId, sources, sourceGroup, isMain) =>
      addNotebookLmSources(
        notebookId,
        sources,
        sourceGroup,
        isMain,
        createNotebookLmClient(),
      ),
    writeGroupsSnapshot: (
      groupFolder,
      isMain,
      availableGroups,
      registeredJids,
    ) =>
      writeGroupsSnapshot(groupFolder, isMain, availableGroups, registeredJids),
  });

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  void startMessageLoop();
}
