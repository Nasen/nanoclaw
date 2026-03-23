import { Server } from 'http';
import { ChildProcess } from 'child_process';

import {
  RcChatSummary,
  RcChatTranscript,
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
type SessionsGetter = () => Record<string, string>;
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

export async function listRcChats(
  channels: Channel[],
  mode: RcDeliveryMode,
  query?: string,
  limit?: number,
): Promise<RcChatSummary[]> {
  return getRcChannel(channels, mode).listChatsForAgent(query, limit);
}

export async function readRcMessages(
  channels: Channel[],
  chatRef: string,
  mode: RcDeliveryMode,
  limit?: number,
): Promise<RcChatTranscript> {
  return getRcChannel(channels, mode).readMessagesForAgent(chatRef, limit);
}

export async function sendRcMessage(
  channels: Channel[],
  chatRef: string,
  text: string,
  mode: RcDeliveryMode,
): Promise<{ jid: string; chatId: string; postId?: string }> {
  return getRcChannel(channels, mode).sendMessageForAgent(chatRef, text);
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
  getSessions: SessionsGetter;
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
  getSessions,
  registerGroup,
  getAvailableGroups,
  processGroupMessages,
  recoverPendingMessages,
  startMessageLoop,
}: StartSubsystemsOptions): void {
  startSchedulerLoop({
    registeredGroups,
    getSessions,
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
