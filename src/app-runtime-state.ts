import fs from 'fs';
import path from 'path';

import { AvailableGroup } from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getRouterState,
  setRegisteredGroup,
  setRouterState,
} from './db.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { initializeServiceState, isServiceEnabled } from './service-state.js';
import { RegisteredGroup } from './types.js';

export interface AppRuntimeState {
  loadState: () => void;
  saveState: () => void;
  getLastTimestamp: () => string;
  setLastTimestamp: (timestamp: string) => void;
  getLastAgentTimestamp: (chatJid: string) => string;
  setLastAgentTimestamp: (chatJid: string, timestamp: string) => void;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getRegisteredGroup: (chatJid: string) => RegisteredGroup | undefined;
  setRegisteredGroups: (groups: Record<string, RegisteredGroup>) => void;
  rememberRegisteredGroup: (jid: string, group: RegisteredGroup) => void;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  isAutoAssistEnabled: () => boolean;
  setAutoAssistEnabled: (enabled: boolean) => void;
  getAvailableGroups: () => AvailableGroup[];
}

const SERVICE_ENABLED_KEY = 'service_enabled';

export function createAppRuntimeState(): AppRuntimeState {
  let lastTimestamp = '';
  let registeredGroups: Record<string, RegisteredGroup> = {};
  let lastAgentTimestamp: Record<string, string> = {};
  let autoAssistEnabled = false;

  const loadState = (): void => {
    lastTimestamp = getRouterState('last_timestamp') || '';
    const agentTs = getRouterState('last_agent_timestamp');
    try {
      lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
      lastAgentTimestamp = {};
    }
    registeredGroups = getAllRegisteredGroups();
    autoAssistEnabled = getRouterState('auto_assist_enabled') === 'true';
    initializeServiceState(getRouterState(SERVICE_ENABLED_KEY) !== 'false');
    logger.info(
      {
        groupCount: Object.keys(registeredGroups).length,
        autoAssistEnabled,
        serviceEnabled: isServiceEnabled(),
      },
      'State loaded',
    );
  };

  const saveState = (): void => {
    setRouterState('last_timestamp', lastTimestamp);
    setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  };

  const registerGroup = (jid: string, group: RegisteredGroup): void => {
    registeredGroups[jid] = group;
    setRegisteredGroup(jid, group);

    const groupDir = path.join(
      GROUPS_DIR || path.join(DATA_DIR, '..', 'groups'),
      group.folder,
    );
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    logger.info(
      { jid, name: group.name, folder: group.folder },
      'Group registered',
    );
  };

  return {
    loadState,
    saveState,
    getLastTimestamp: () => lastTimestamp,
    setLastTimestamp: (timestamp) => {
      lastTimestamp = timestamp;
    },
    getLastAgentTimestamp: (chatJid) => lastAgentTimestamp[chatJid] || '',
    setLastAgentTimestamp: (chatJid, timestamp) => {
      lastAgentTimestamp[chatJid] = timestamp;
    },
    getRegisteredGroups: () => registeredGroups,
    getRegisteredGroup: (chatJid) => registeredGroups[chatJid],
    setRegisteredGroups: (groups) => {
      registeredGroups = groups;
    },
    rememberRegisteredGroup: (jid, group) => {
      registeredGroups[jid] = group;
    },
    registerGroup,
    isAutoAssistEnabled: () => autoAssistEnabled,
    setAutoAssistEnabled: (enabled) => {
      autoAssistEnabled = enabled;
      setRouterState('auto_assist_enabled', enabled ? 'true' : 'false');
      logger.info({ enabled }, 'Auto-assist mode changed');
    },
    getAvailableGroups: () => {
      const chats = getAllChats();
      const registeredJids = new Set(Object.keys(registeredGroups));

      return chats
        .filter((chat) => chat.jid !== '__group_sync__' && chat.is_group)
        .map((chat) => ({
          jid: chat.jid,
          name: chat.name,
          lastActivity: chat.last_message_time,
          isRegistered: registeredJids.has(chat.jid),
        }));
    },
  };
}
