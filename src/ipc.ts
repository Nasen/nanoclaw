import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { isMainGroup, isMainGroupFolder } from './group-access.js';
import { processMessageFiles } from './ipc-message-handler.js';
import { processTaskIpc, TaskIpcData } from './ipc-task-handler.js';
import { logger } from './logger.js';
import {
  NotebookLmAddSourcesResult,
  NotebookLmNotebook,
  NotebookLmSourceInput,
} from './notebooklm.js';
import { RcDeliveryMode, RegisteredGroup } from './types.js';
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
} from './channels/ringcentral.js';

export { processTaskIpc } from './ipc-task-handler.js';

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    rcDeliveryMode?: RcDeliveryMode,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  rcListChats: (
    mode: RcDeliveryMode,
    query?: string,
    limit?: number,
  ) => Promise<RcChatSummary[]>;
  rcReadMessages: (
    chatRef: string,
    mode: RcDeliveryMode,
    limit?: number,
  ) => Promise<RcChatTranscript>;
  rcSendMessage: (
    chatRef: string,
    text: string,
    mode: RcDeliveryMode,
  ) => Promise<{ jid: string; chatId: string; postId?: string }>;
  rcListChatMembers: (
    chatRef: string,
    mode: RcDeliveryMode,
    limit?: number,
  ) => Promise<RcChatMember[]>;
  rcGetPresence: (
    mode: RcDeliveryMode,
    extensionId?: string,
  ) => Promise<RcPresence>;
  rcSetPresence: (
    mode: RcDeliveryMode,
    update: RcPresenceUpdateInput,
  ) => Promise<RcPresence>;
  rcGetExtension: (
    mode: RcDeliveryMode,
    extensionId?: string,
  ) => Promise<RcExtensionSummary>;
  rcListExtensions: (
    mode: RcDeliveryMode,
    query?: string,
    limit?: number,
  ) => Promise<RcExtensionSummary[]>;
  rcListContacts: (
    mode: RcDeliveryMode,
    query?: string,
    limit?: number,
  ) => Promise<RcContact[]>;
  rcCreateContact: (
    mode: RcDeliveryMode,
    contact: RcContactInput,
  ) => Promise<RcContact>;
  rcListPhoneNumbers: (
    mode: RcDeliveryMode,
    limit?: number,
  ) => Promise<RcPhoneNumber[]>;
  notebookLmListNotebooks: (limit?: number) => Promise<NotebookLmNotebook[]>;
  notebookLmCreateNotebook: (title: string) => Promise<NotebookLmNotebook>;
  notebookLmGetNotebook: (notebookId: string) => Promise<NotebookLmNotebook>;
  notebookLmAddSources: (
    notebookId: string,
    sources: NotebookLmSourceInput[],
    sourceGroup: string,
    isMain: boolean,
  ) => Promise<NotebookLmAddSourcesResult>;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      folderIsMain.set(group.folder, isMainGroup(group));
    }

    for (const sourceGroup of groupFolders) {
      const isMain =
        folderIsMain.get(sourceGroup) === true ||
        isMainGroupFolder(sourceGroup);
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
      const errorDir = path.join(ipcBaseDir, 'errors');

      try {
        await processMessageFiles(
          messagesDir,
          sourceGroup,
          isMain,
          registeredGroups,
          { sendMessage: deps.sendMessage },
          errorDir,
        );
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(
                fs.readFileSync(filePath, 'utf-8'),
              ) as TaskIpcData;
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}
