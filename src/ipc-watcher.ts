import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from './config.js';
import { isMainGroup, isMainGroupFolder } from './group-access.js';
import { processMessageFiles } from './ipc-message-handler.js';
import { processTaskIpc, TaskIpcData } from './ipc-task-handler.js';
import { IpcDeps } from './ipc-types.js';
import { logger } from './logger.js';

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
    let groupFolders: string[];
    try {
      fs.mkdirSync(ipcBaseDir, { recursive: true });
      groupFolders = fs.readdirSync(ipcBaseDir).filter((folder) => {
        const stat = fs.statSync(path.join(ipcBaseDir, folder));
        return stat.isDirectory() && folder !== 'errors';
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        fs.mkdirSync(ipcBaseDir, { recursive: true });
        logger.warn(
          { ipcBaseDir },
          'IPC base directory was missing and has been recreated',
        );
      } else {
        logger.error({ err }, 'Error reading IPC base directory');
      }
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();
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
            .filter((file) => file.endsWith('.json'));
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
