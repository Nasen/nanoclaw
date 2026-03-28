import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import { ChannelOpts } from './channels/registry.js';
import {
  connectInstalledChannels,
  connectRingCentralChannels,
} from './channel-bootstrap.js';
import { ContainerOutput } from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import {
  consumePendingMessages,
  recoverPendingMessages as recoverPendingMessagesForGroups,
  startMessageLoop as startPollingMessageLoop,
} from './message-loop.js';
import { formatMessages } from './router.js';
import {
  processGroupMessages as processGroupMessagesForChat,
  runGroupAgent,
} from './group-agent-runner.js';
import {
  isSenderAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  buildServiceToggleConfirmation,
  buildUnauthorizedServiceControlMessage,
  isAdminServiceControlGroup,
  parseServiceToggleCommand,
} from './service-control.js';
import {
  initializeServiceState,
  isServiceEnabled,
  setRuntimeServiceEnabled,
} from './service-state.js';
import {
  registerShutdownHandlers,
  startSubsystems,
} from './orchestrator-runtime.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// Auto-assist toggle for personal RC DMs — persisted in router_state DB.
// OFF by default: Nasen handles his own DMs until he explicitly enables.
let autoAssistEnabled = false;
const SERVICE_ENABLED_KEY = 'service_enabled';

const channels: Channel[] = [];
const queue = new GroupQueue();

async function sendDirectControlMessage(
  chatJid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((candidate) => candidate.ownsJid(chatJid));
  if (!channel) {
    logger.warn({ chatJid }, 'No channel found for control message');
    return;
  }
  await channel.sendMessage(chatJid, text);
}

async function setServiceEnabled(
  enabled: boolean,
  reason: 'admin_chat' | 'owner_command',
): Promise<boolean> {
  const changed = setRuntimeServiceEnabled(enabled);

  setRouterState(SERVICE_ENABLED_KEY, enabled ? 'true' : 'false');
  logger.info({ enabled, changed, reason }, 'Service mode changed');
  await queue.setServiceEnabled(enabled);

  if (!enabled) {
    consumePendingMessages(
      registeredGroups,
      (chatJid) => lastAgentTimestamp[chatJid] || '',
      (chatJid, timestamp) => {
        lastAgentTimestamp[chatJid] = timestamp;
      },
      saveState,
    );
  }

  return changed;
}

function maybeHandleServiceControlMessage(
  chatJid: string,
  msg: NewMessage,
): boolean {
  const enabled = parseServiceToggleCommand(msg.content);
  if (enabled === null) return false;

  const group = registeredGroups[chatJid];
  if (!isAdminServiceControlGroup(group)) {
    if (isServiceEnabled()) {
      void sendDirectControlMessage(
        chatJid,
        buildUnauthorizedServiceControlMessage(),
      ).catch((err) =>
        logger.error(
          { chatJid, err },
          'Failed to send unauthorized control reply',
        ),
      );
    }
    return true;
  }

  void setServiceEnabled(enabled, 'admin_chat')
    .then((changed) =>
      sendDirectControlMessage(
        chatJid,
        buildServiceToggleConfirmation(enabled, changed),
      ),
    )
    .catch((err) =>
      logger.error({ chatJid, err }, 'Failed to apply service control command'),
    );
  return true;
}

function buildChannelOpts(): ChannelOpts {
  return {
    onMessage: (chatJid: string, msg: NewMessage) => {
      if (maybeHandleServiceControlMessage(chatJid, msg)) {
        return;
      }

      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
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
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function setAutoAssist(enabled: boolean): void {
  autoAssistEnabled = enabled;
  setRouterState('auto_assist_enabled', enabled ? 'true' : 'false');
  logger.info({ enabled }, 'Auto-assist mode changed');
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  return processGroupMessagesForChat(chatJid, {
    channels,
    queue,
    getRegisteredGroup: (jid) => registeredGroups[jid],
    getLastAgentTimestamp: (jid) => lastAgentTimestamp[jid] || '',
    setLastAgentTimestamp: (jid, timestamp) => {
      lastAgentTimestamp[jid] = timestamp;
    },
    saveState,
    autoAssistEnabled: () => autoAssistEnabled,
    getSessionId: (groupFolder) => sessions[groupFolder],
    setSessionId: (groupFolder, sessionId) => {
      sessions[groupFolder] = sessionId;
      setSession(groupFolder, sessionId);
    },
    getAvailableGroups,
    getRegisteredJids: () => new Set(Object.keys(registeredGroups)),
  });
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  return runGroupAgent(
    group,
    prompt,
    chatJid,
    {
      queue,
      getSessionId: (groupFolder) => sessions[groupFolder],
      setSessionId: (groupFolder, sessionId) => {
        sessions[groupFolder] = sessionId;
        setSession(groupFolder, sessionId);
      },
      getAvailableGroups,
      getRegisteredJids: () => new Set(Object.keys(registeredGroups)),
    },
    onOutput,
  );
}

async function startMessageLoop(): Promise<void> {
  await startPollingMessageLoop({
    channels,
    queue,
    registeredGroups: () => registeredGroups,
    getLastTimestamp: () => lastTimestamp,
    setLastTimestamp: (timestamp) => {
      lastTimestamp = timestamp;
    },
    getLastAgentTimestamp: (chatJid) => lastAgentTimestamp[chatJid] || '',
    setLastAgentTimestamp: (chatJid, timestamp) => {
      lastAgentTimestamp[chatJid] = timestamp;
    },
    saveState,
  });
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  if (!isServiceEnabled()) {
    consumePendingMessages(
      registeredGroups,
      (chatJid) => lastAgentTimestamp[chatJid] || '',
      (chatJid, timestamp) => {
        lastAgentTimestamp[chatJid] = timestamp;
      },
      saveState,
    );
    return;
  }

  recoverPendingMessagesForGroups(
    registeredGroups,
    (chatJid) => lastAgentTimestamp[chatJid] || '',
    queue,
  );
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  await queue.setServiceEnabled(isServiceEnabled());

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );
  registerShutdownHandlers(proxyServer, queue, channels);

  const channelOpts = buildChannelOpts();
  await connectInstalledChannels(channels, channelOpts);
  await connectRingCentralChannels({
    channelOpts,
    channels,
    registeredGroups: () => registeredGroups,
    setAutoAssist,
    setServiceEnabled: async (enabled, chatJid) => {
      const changed = await setServiceEnabled(enabled, 'owner_command');
      await sendDirectControlMessage(
        chatJid,
        buildServiceToggleConfirmation(enabled, changed),
      );
    },
    onRegisterGroup: (jid, group) => {
      registeredGroups[jid] = group;
    },
  });

  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  startSubsystems({
    channels,
    queue,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    registerGroup,
    getAvailableGroups,
    processGroupMessages,
    recoverPendingMessages,
    startMessageLoop,
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
