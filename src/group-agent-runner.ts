import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { getAllTasks } from './db.js';
import { isMainFolder, isPersonalFolder } from './rc-auto-register.js';
import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { resolveOutboundTarget } from './router.js';
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
  getSessionId: (groupFolder: string) => string | undefined;
  setSessionId: (groupFolder: string, sessionId: string) => void;
  getAvailableGroups: () => AvailableGroup[];
  getRegisteredJids: () => Set<string>;
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
  const sessionId = deps.getSessionId(group.folder);

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
        if (output.newSessionId) {
          deps.setSessionId(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        personalMode: isMain || isPersonalFolder(group.folder, GROUPS_DIR),
      },
      (proc, containerName) =>
        deps.queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      deps.setSessionId(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
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
  chatJid: string,
  messages: Array<{ content: string; is_from_me?: boolean }>,
): boolean {
  if (!chatJid.startsWith('rcb:')) return false;

  const latestInbound = [...messages]
    .reverse()
    .find((message) => !message.is_from_me);
  if (!latestInbound) return false;

  return /\b(on my behalf|on behalf of me|as me|reply as me|send as me|speak as me|use my personal (?:rc|ringcentral|account|credentials)|use my credentials|using my credentials|use personal credentials|from my account|via my account|via my personal rc)\b/i.test(
    latestInbound.content,
  );
}

export async function processGroupMessages(
  chatJid: string,
  deps: ProcessGroupMessagesDeps,
): Promise<boolean> {
  const group = deps.getRegisteredGroup(chatJid);
  if (!group) return true;

  const { findChannel, formatMessages } = await import('./router.js');
  const { getMessagesSince } = await import('./db.js');
  const { groupNeedsTrigger, hasAllowedTrigger, isPersonalRcDm } =
    await import('./message-gating.js');
  const { loadSenderAllowlist } = await import('./sender-allowlist.js');
  const { ASSISTANT_NAME, IDLE_TIMEOUT, TIMEZONE } =
    await import('./config.js');

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
    if (!hasAllowedTrigger(chatJid, missedMessages, allowlistCfg)) return true;
  }

  const personalRcDm = isPersonalRcDm(chatJid, group);
  if (personalRcDm && !deps.autoAssistEnabled()) {
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

  const usePersonalRcDelivery =
    group.folder === 'rc-personal' ||
    shouldUsePersonalRcDelivery(chatJid, missedMessages);
  const rcRoutingPrefix =
    chatJid.startsWith('rc:') || chatJid.startsWith('rcb:')
      ? usePersonalRcDelivery
        ? '[RingCentral routing: The latest user request asks you to act on Nasen\'s behalf. For outbound actions in this chat, prefer send_message with delivery_mode="personal".]\n\n'
        : '[RingCentral routing: send_message supports delivery_mode="personal" for Nasen\'s personal RC app and delivery_mode="bot" for the bot app. Use personal when the user explicitly asks you to act as Nasen or use his personal RC account.]\n\n'
      : '';

  const prompt =
    autoAssistPrefix +
    rcRoutingPrefix +
    formatMessages(missedMessages, TIMEZONE);
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

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      deps.queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runGroupAgent(
    group,
    prompt,
    chatJid,
    deps,
    async (result) => {
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
          const target = resolveOutboundTarget(
            deps.channels,
            chatJid,
            usePersonalRcDelivery ? 'personal' : 'auto',
          );
          if (!target) {
            throw new Error(`No channel for JID: ${chatJid}`);
          }
          await target.channel.sendMessage(target.jid, text);
          outputSentToUser = true;
        }
        resetIdleTimer();
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
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
