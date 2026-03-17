import { Server } from 'http';
import { ChildProcess } from 'child_process';

import { writeGroupsSnapshot } from './container-runner.js';
import { startIpcWatcher } from './ipc.js';
import { logger } from './logger.js';
import { findChannel, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, RegisteredGroup } from './types.js';
import { GroupQueue } from './group-queue.js';

type RegisteredGroupsGetter = () => Record<string, RegisteredGroup>;
type SessionsGetter = () => Record<string, string>;
type AvailableGroupsGetter = () => import('./container-runner.js').AvailableGroup[];

export async function sendFormattedMessage(
  channels: Channel[],
  jid: string,
  rawText: string,
): Promise<void> {
  const channel = findChannel(channels, jid);
  if (!channel) {
    console.log(`Warning: no channel owns JID ${jid}, cannot send message`);
    return;
  }

  const text = formatOutbound(rawText);
  if (text) await channel.sendMessage(jid, text);
}

export async function sendChannelMessage(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = findChannel(channels, jid);
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  await channel.sendMessage(jid, text);
}

export async function syncChannelGroups(
  channels: Channel[],
  force: boolean,
): Promise<void> {
  await Promise.all(
    channels.filter((channel) => channel.syncGroups).map((channel) => channel.syncGroups!(force)),
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
    sendMessage: (jid, text) => sendChannelMessage(channels, jid, text),
    registeredGroups,
    registerGroup,
    syncGroups: (force) => syncChannelGroups(channels, force),
    getAvailableGroups,
    writeGroupsSnapshot: (groupFolder, isMain, availableGroups, registeredJids) =>
      writeGroupsSnapshot(groupFolder, isMain, availableGroups, registeredJids),
  });

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  void startMessageLoop();
}
