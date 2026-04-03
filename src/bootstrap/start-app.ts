import { CREDENTIAL_PROXY_PORT } from '../config.js';
import { createAppRuntimeState } from '../app-runtime-state.js';
import {
  buildChannelOpts,
  sendDirectControlMessage,
  setServiceEnabled,
} from '../app-controls.js';
import {
  createProcessGroupMessagesHandler,
  createStartMessageLoop,
  recoverPendingMessages,
} from '../app-processing.js';
import { startCredentialProxy } from '../credential-proxy.js';
import '../channels/index.js';
import {
  connectInstalledChannels,
  connectRingCentralChannels,
} from '../channel-bootstrap.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from '../container-runtime.js';
import { AvailableGroup } from '../container-contract.js';
import { initDatabase } from '../db.js';
import { GroupQueue } from '../group-queue.js';
import { buildServiceToggleConfirmation } from '../service-control.js';
import { isServiceEnabled } from '../service-state.js';
import {
  registerShutdownHandlers,
  startSubsystems,
} from '../orchestrator-runtime.js';
import { logger } from '../logger.js';
import { Channel, RegisteredGroup } from '../types.js';

const channels: Channel[] = [];
const queue = new GroupQueue();
const state = createAppRuntimeState();

/**
 * Returns groups ordered by most recent activity for agent-facing prompts.
 */
export function getAvailableGroups(): AvailableGroup[] {
  return state.getAvailableGroups();
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  state.setRegisteredGroups(groups);
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

export async function startNanoClaw(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  state.loadState();
  await queue.setServiceEnabled(isServiceEnabled());

  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );
  registerShutdownHandlers(proxyServer, queue, channels);

  const channelOpts = buildChannelOpts({ channels, queue, state });
  await connectInstalledChannels(channels, channelOpts);
  await connectRingCentralChannels({
    channelOpts,
    channels,
    registeredGroups: state.getRegisteredGroups,
    setAutoAssist: state.setAutoAssistEnabled,
    setServiceEnabled: async (enabled, chatJid) => {
      const changed = await setServiceEnabled(
        { channels, queue, state },
        enabled,
        'owner_command',
      );
      await sendDirectControlMessage(
        channels,
        chatJid,
        buildServiceToggleConfirmation(enabled, changed),
      );
    },
    onRegisterGroup: state.rememberRegisteredGroup,
  });

  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  startSubsystems({
    channels,
    queue,
    registeredGroups: state.getRegisteredGroups,
    registerGroup: state.registerGroup,
    getAvailableGroups,
    processGroupMessages: createProcessGroupMessagesHandler({
      channels,
      queue,
      state,
    }),
    recoverPendingMessages: () => recoverPendingMessages({ queue, state }),
    startMessageLoop: createStartMessageLoop({ channels, queue, state }),
  });
}
