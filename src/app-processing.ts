import {
  consumePendingMessages,
  recoverPendingMessages as recoverPendingMessagesForGroups,
  startMessageLoop as startPollingMessageLoop,
} from './message-loop.js';
import { processGroupMessages as processGroupMessagesForChat } from './group-agent-runner.js';
import { AppRuntimeState } from './app-runtime-state.js';
import { Channel } from './types.js';
import { GroupQueue } from './group-queue.js';
import { isServiceEnabled } from './service-state.js';

interface AppProcessingDeps {
  channels: Channel[];
  queue: GroupQueue;
  state: AppRuntimeState;
}

export function createProcessGroupMessagesHandler(
  deps: AppProcessingDeps,
): (chatJid: string) => Promise<boolean> {
  return (chatJid) =>
    processGroupMessagesForChat(chatJid, {
      channels: deps.channels,
      queue: deps.queue,
      getRegisteredGroup: deps.state.getRegisteredGroup,
      getRegisteredGroups: deps.state.getRegisteredGroups,
      getLastAgentTimestamp: deps.state.getLastAgentTimestamp,
      setLastAgentTimestamp: deps.state.setLastAgentTimestamp,
      saveState: deps.state.saveState,
      autoAssistEnabled: deps.state.isAutoAssistEnabled,
      getAvailableGroups: deps.state.getAvailableGroups,
      getRegisteredJids: () =>
        new Set(Object.keys(deps.state.getRegisteredGroups())),
    });
}

export function createStartMessageLoop(
  deps: AppProcessingDeps,
): () => Promise<void> {
  return () =>
    startPollingMessageLoop({
      channels: deps.channels,
      queue: deps.queue,
      registeredGroups: deps.state.getRegisteredGroups,
      getLastTimestamp: deps.state.getLastTimestamp,
      setLastTimestamp: deps.state.setLastTimestamp,
      getLastAgentTimestamp: deps.state.getLastAgentTimestamp,
      setLastAgentTimestamp: deps.state.setLastAgentTimestamp,
      saveState: deps.state.saveState,
    });
}

export function recoverPendingMessages(
  deps: Pick<AppProcessingDeps, 'queue' | 'state'>,
): void {
  if (!isServiceEnabled()) {
    consumePendingMessages(
      deps.state.getRegisteredGroups(),
      deps.state.getLastAgentTimestamp,
      deps.state.setLastAgentTimestamp,
      deps.state.saveState,
    );
    return;
  }

  recoverPendingMessagesForGroups(
    deps.state.getRegisteredGroups(),
    deps.state.getLastAgentTimestamp,
    deps.queue,
  );
}
