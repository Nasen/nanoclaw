import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { getAllTasks, getSession, setSession } from './db.js';
import { isMainFolder, isPersonalFolder } from './rc-auto-register.js';
import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { formatOnBehalfAssistantMessage } from './on-behalf-message.js';
import {
  isRingCentralChatJid,
  hasExplicitOnBehalfIntentInMessages,
  resolveCurrentChatRcDelivery,
} from './rc-delivery-policy.js';
import { resolveOutboundTarget } from './router.js';
import { getServiceStateVersion, isServiceEnabled } from './service-state.js';
import {
  buildChatTurnInput,
  handleReservedSlashCommand,
  hasAllowedStandaloneSlashCommand,
} from './slash-commands.js';
import { RegisteredGroup } from './types.js';
import { GroupQueue } from './group-queue.js';

interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

interface RunGroupAgentDeps {
  queue: GroupQueue;
  getAvailableGroups: () => AvailableGroup[];
  getRegisteredJids: () => Set<string>;
}

export function shouldCloseContainerAfterTurn(
  _group: RegisteredGroup,
  _result: ContainerOutput,
): boolean {
  return false;
}

export async function runGroupAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  deps: RunGroupAgentDeps,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain =
    group.isMain === true || isMainFolder(group.folder, GROUPS_DIR);

  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((task) => ({
      id: task.id,
      groupFolder: task.group_folder,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      status: task.status,
      next_run: task.next_run,
    })),
  );

  writeGroupsSnapshot(
    group.folder,
    isMain,
    deps.getAvailableGroups(),
    deps.getRegisteredJids(),
  );

  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId: getSession(group.folder),
        groupFolder: group.folder,
        chatJid,
        isMain,
        personalMode: isMain || isPersonalFolder(group.folder, GROUPS_DIR),
      },
      (proc, containerName) =>
        deps.queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    if (output.newSessionId) {
      setSession(group.folder, output.newSessionId);
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

interface ProcessGroupMessagesDeps extends RunGroupAgentDeps {
  channels: import('./types.js').Channel[];
  getRegisteredGroup: (chatJid: string) => RegisteredGroup | undefined;
  getLastAgentTimestamp: (chatJid: string) => string;
  setLastAgentTimestamp: (chatJid: string, timestamp: string) => void;
  saveState: () => void;
  autoAssistEnabled: () => boolean;
}

function shouldUsePersonalRcDelivery(
  messages: Array<{ content: string; is_from_me?: boolean }>,
): boolean {
  return hasExplicitOnBehalfIntentInMessages(messages);
}

export async function processGroupMessages(
  chatJid: string,
  deps: ProcessGroupMessagesDeps,
): Promise<boolean> {
  const serviceStateVersion = getServiceStateVersion();
  const group = deps.getRegisteredGroup(chatJid);
  if (!group) return true;

  const { findChannel } = await import('./router.js');
  const { getMessagesSince } = await import('./db.js');
  const { groupNeedsTrigger, hasAllowedTrigger, isPersonalRcDm } =
    await import('./message-gating.js');
  const { loadSenderAllowlist } = await import('./sender-allowlist.js');
  const { ASSISTANT_NAME, TIMEZONE } = await import('./config.js');

  const channel = findChannel(deps.channels, chatJid);
  if (!channel) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return true;
  }

  const missedMessages = getMessagesSince(
    chatJid,
    deps.getLastAgentTimestamp(chatJid),
    ASSISTANT_NAME,
  );
  if (missedMessages.length === 0) return true;

  if (groupNeedsTrigger(group)) {
    const allowlistCfg = loadSenderAllowlist();
    if (
      !hasAllowedTrigger(chatJid, missedMessages, allowlistCfg) &&
      !hasAllowedStandaloneSlashCommand(chatJid, missedMessages, allowlistCfg)
    ) {
      return true;
    }
  }

  const turnInput = buildChatTurnInput(missedMessages, TIMEZONE);

  const personalRcDm = isPersonalRcDm(chatJid, group);
  if (personalRcDm && !deps.autoAssistEnabled() && !turnInput.slashCommand) {
    logger.debug(
      { group: group.name },
      'Auto-assist OFF — skipping agent for personal RC DM',
    );
    return true;
  }

  const autoAssistPrefix =
    personalRcDm && deps.autoAssistEnabled()
      ? '[Auto-assistant mode is ON. Nasen is away. Respond on his behalf — including any backlog messages sent while auto-assist was off.]\n\n'
      : '';

  const onBehalfIntent = shouldUsePersonalRcDelivery(missedMessages);
  const deliveryDecision = resolveCurrentChatRcDelivery({
    chatJid,
    onBehalfIntent,
  });
  const usePersonalRcDelivery = deliveryDecision.mode === 'personal';
  const rcRoutingPrefix =
    chatJid.startsWith('rc:') || chatJid.startsWith('rcb:')
      ? group.folder === 'rc-personal'
        ? '[RingCentral routing: For this chat, normal replies use bot delivery by policy. Only explicit on-behalf requests should use personal delivery.]\n\n'
        : usePersonalRcDelivery
          ? "[RingCentral routing: The latest user request explicitly asks you to act on Nasen's behalf. Outbound actions for this current chat must use personal delivery.]\n\n"
          : '[RingCentral routing: Normal replies in RingCentral use bot delivery by policy. Personal delivery is only for explicit on-behalf requests.]\n\n'
      : '';

  if (turnInput.slashCommand) {
    const handled = await handleReservedSlashCommand({
      slashCommand: turnInput.slashCommand,
      chatJid,
      groupFolder: group.folder,
      queue: deps.queue,
      sendMessage: (text) => channel.sendMessage(chatJid, text),
    });
    if (handled) {
      deps.setLastAgentTimestamp(
        chatJid,
        missedMessages[missedMessages.length - 1].timestamp,
      );
      deps.saveState();
      return true;
    }
  }

  const prompt =
    turnInput.mode === 'raw'
      ? turnInput.text
      : autoAssistPrefix + rcRoutingPrefix + turnInput.text;
  const previousCursor = deps.getLastAgentTimestamp(chatJid);
  deps.setLastAgentTimestamp(
    chatJid,
    missedMessages[missedMessages.length - 1].timestamp,
  );
  deps.saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runGroupAgent(
    group,
    prompt,
    chatJid,
    deps,
    async (result) => {
      if (result.newSessionId) {
        setSession(group.folder, result.newSessionId);
      }

      if (
        !isServiceEnabled() ||
        getServiceStateVersion() !== serviceStateVersion
      ) {
        logger.info(
          { group: group.name },
          'Dropping agent output because service was disabled mid-run',
        );
        return;
      }

      if (result.lifecycle === 'query_started') {
        return;
      }

      if (result.lifecycle === 'idle_waiting') {
        deps.queue.notifyIdle(chatJid);
        await channel.setTyping?.(chatJid, false);
        return;
      }

      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          if (deliveryDecision.policyForced && chatJid.startsWith('rc')) {
            logger.info(
              {
                group: group.name,
                requestedMode: 'auto',
                enforcedMode: deliveryDecision.mode,
              },
              'Applied host-enforced RingCentral current-chat delivery policy',
            );
          }
          const target = resolveOutboundTarget(
            deps.channels,
            chatJid,
            deliveryDecision.mode,
          );
          if (!target) {
            throw new Error(`No channel for JID: ${chatJid}`);
          }
          const outboundText =
            isRingCentralChatJid(chatJid) &&
            deliveryDecision.mode === 'personal'
              ? formatOnBehalfAssistantMessage(text)
              : text;
          await target.channel.sendMessage(target.jid, outboundText);
          outputSentToUser = true;
        }
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);

  if (output === 'error' || hadError) {
    if (getServiceStateVersion() !== serviceStateVersion) {
      logger.info(
        { group: group.name },
        'Service state changed mid-run, treating message work as cancelled',
      );
      return true;
    }

    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }

    deps.setLastAgentTimestamp(chatJid, previousCursor);
    deps.saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}
