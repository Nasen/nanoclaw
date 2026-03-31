import { consumePendingMessages } from './message-loop.js';
import {
  buildServiceToggleConfirmation,
  buildUnauthorizedServiceControlMessage,
  isAdminServiceControlGroup,
  parseServiceToggleCommand,
} from './service-control.js';
import { isServiceEnabled, setRuntimeServiceEnabled } from './service-state.js';
import { logger } from './logger.js';
import {
  isSenderAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { setRouterState, storeChatMetadata, storeMessage } from './db.js';
import { GroupQueue } from './group-queue.js';
import { ChannelOpts } from './channels/registry.js';
import { Channel, NewMessage } from './types.js';
import { AppRuntimeState } from './app-runtime-state.js';

const SERVICE_ENABLED_KEY = 'service_enabled';

export type ServiceEnabledReason = 'admin_chat' | 'owner_command';

interface AppControlDeps {
  channels: Channel[];
  queue: GroupQueue;
  state: AppRuntimeState;
}

export async function sendDirectControlMessage(
  channels: Channel[],
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

export async function setServiceEnabled(
  deps: AppControlDeps,
  enabled: boolean,
  reason: ServiceEnabledReason,
): Promise<boolean> {
  const changed = setRuntimeServiceEnabled(enabled);

  setRouterState(SERVICE_ENABLED_KEY, enabled ? 'true' : 'false');
  logger.info({ enabled, changed, reason }, 'Service mode changed');
  await deps.queue.setServiceEnabled(enabled);

  if (!enabled) {
    consumePendingMessages(
      deps.state.getRegisteredGroups(),
      deps.state.getLastAgentTimestamp,
      deps.state.setLastAgentTimestamp,
      deps.state.saveState,
    );
  }

  return changed;
}

function maybeHandleServiceControlMessage(
  deps: AppControlDeps,
  chatJid: string,
  msg: NewMessage,
): boolean {
  const enabled = parseServiceToggleCommand(msg.content);
  if (enabled === null) return false;

  const group = deps.state.getRegisteredGroup(chatJid);
  if (!isAdminServiceControlGroup(group)) {
    if (isServiceEnabled()) {
      void sendDirectControlMessage(
        deps.channels,
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

  void setServiceEnabled(deps, enabled, 'admin_chat')
    .then((changed) =>
      sendDirectControlMessage(
        deps.channels,
        chatJid,
        buildServiceToggleConfirmation(enabled, changed),
      ),
    )
    .catch((err) =>
      logger.error({ chatJid, err }, 'Failed to apply service control command'),
    );
  return true;
}

export function buildChannelOpts(deps: AppControlDeps): ChannelOpts {
  return {
    onMessage: (chatJid, msg) => {
      if (maybeHandleServiceControlMessage(deps, chatJid, msg)) {
        return;
      }

      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        deps.state.getRegisteredGroup(chatJid)
      ) {
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
    onChatMetadata: (chatJid, timestamp, name, channel, isGroup) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: deps.state.getRegisteredGroups,
  };
}
