import { runContainerAgent } from './container-runner.js';
import {
  delegateToAdminGroup,
  resolveDelegationDelivery,
} from './admin-delegation.js';
import {
  getAdminAgentProfile,
  getAdminAgentPromptHeader,
  isSupervisorGroup,
} from './admin-agents.js';
import { ContainerOutput } from './container-contract.js';
import {
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-snapshots.js';
import { getAllTasks, getSession, setSession } from './db.js';
import { isMainGroup, isPersonalModeGroup } from './group-access.js';
import {
  buildGroupTurnPrompt,
  relayGroupTurnResult,
  shouldSkipGroupTurnForAutoAssist,
} from './group-turn-policy.js';
import { logger } from './logger.js';
import { getServiceStateVersion, isServiceEnabled } from './service-state.js';
import {
  buildChatTurnInput,
  handleReservedSlashCommand,
  hasAllowedStandaloneSlashCommand,
} from './slash-commands.js';
import {
  buildSupervisorRoutingPromptPrefix,
  resolveSupervisorRoute,
} from './supervisor-routing.js';
import { RegisteredGroup } from './types.js';
import { GroupQueue } from './group-queue.js';

import { AvailableGroup } from './container-contract.js';

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
  const isMain = isMainGroup(group);
  const adminProfile = getAdminAgentProfile(group.folder);

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
        prompt: `${getAdminAgentPromptHeader(group)}${prompt}`,
        sessionId: getSession(group.folder),
        groupFolder: group.folder,
        chatJid,
        isMain,
        personalMode: isPersonalModeGroup(group),
        adminRole: adminProfile?.role,
        canSpeakAsOwner: adminProfile?.canSpeakAsOwner,
        allowedExternalMcpCapabilities:
          adminProfile?.externalMcpCapabilities ?? [],
        allowedNanoclawTools: adminProfile?.nanoclawTools ?? [],
        allowedPeerGroups: adminProfile?.allowedPeers ?? [],
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

async function tryAutoDelegateSupervisorTurn(params: {
  group: RegisteredGroup;
  chatJid: string;
  prompt: string;
  routingDecision: ReturnType<typeof resolveSupervisorRoute>;
  queue: GroupQueue;
  channels: import('./types.js').Channel[];
  getAvailableGroups: () => AvailableGroup[];
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
}): Promise<{ status: 'delegated' } | { status: 'fallback'; reason: string }> {
  if (
    params.routingDecision.mode !== 'delegate' ||
    !params.routingDecision.targetGroupFolder
  ) {
    return {
      status: 'fallback',
      reason: params.routingDecision.reason,
    };
  }

  const registeredGroups = params.getRegisteredGroups();
  const targetEntry = Object.entries(registeredGroups).find(
    ([, group]) => group.folder === params.routingDecision.targetGroupFolder,
  );
  if (!targetEntry) {
    return {
      status: 'fallback',
      reason: `Target group ${params.routingDecision.targetGroupFolder} is not registered.`,
    };
  }

  const [targetGroupJid, targetGroup] = targetEntry;

  try {
    const delegated = await delegateToAdminGroup({
      sourceGroupFolder: params.group.folder,
      targetGroupJid,
      targetGroup,
      queue: params.queue,
      getAvailableGroups: params.getAvailableGroups,
      getRegisteredGroups: params.getRegisteredGroups,
      prompt: params.prompt,
    });
    const delivery = resolveDelegationDelivery({
      sourceGroupFolder: params.group.folder,
      sourceGroupName: params.group.name,
      targetGroupName: targetGroup.name,
      prompt: params.prompt,
      result: delegated.result,
    });

    if (delivery.postToTargetChat && delivery.targetChatText) {
      const { resolveOutboundTarget } = await import('./router.js');
      const target = resolveOutboundTarget(
        params.channels,
        targetGroupJid,
        'bot',
      );
      if (!target) {
        throw new Error(`No outbound channel for ${targetGroupJid}`);
      }
      await target.channel.sendMessage(target.jid, delivery.targetChatText);
    }

    if (delivery.callerResult) {
      const { resolveOutboundTarget } = await import('./router.js');
      const sourceTarget = resolveOutboundTarget(
        params.channels,
        params.chatJid,
        'bot',
      );
      if (!sourceTarget) {
        throw new Error(`No outbound channel for ${params.chatJid}`);
      }
      await sourceTarget.channel.sendMessage(
        sourceTarget.jid,
        delivery.callerResult,
      );
    }

    return { status: 'delegated' };
  } catch (err) {
    logger.warn(
      {
        group: params.group.name,
        targetGroup: params.routingDecision.targetGroupFolder,
        err,
      },
      'Supervisor auto-delegation failed, falling back to direct handling',
    );
    return {
      status: 'fallback',
      reason:
        err instanceof Error
          ? err.message
          : 'Supervisor auto-delegation failed.',
    };
  }
}

interface ProcessGroupMessagesDeps extends RunGroupAgentDeps {
  channels: import('./types.js').Channel[];
  getRegisteredGroup: (chatJid: string) => RegisteredGroup | undefined;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getLastAgentTimestamp: (chatJid: string) => string;
  setLastAgentTimestamp: (chatJid: string, timestamp: string) => void;
  saveState: () => void;
  autoAssistEnabled: () => boolean;
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
  if (
    shouldSkipGroupTurnForAutoAssist({
      personalRcDm,
      autoAssistEnabled: deps.autoAssistEnabled(),
      hasSlashCommand: Boolean(turnInput.slashCommand),
    })
  ) {
    logger.debug(
      { group: group.name },
      'Auto-assist OFF — skipping agent for personal RC DM',
    );
    return true;
  }

  const { prompt, deliveryDecision } = buildGroupTurnPrompt({
    chatJid,
    groupFolder: group.folder,
    messages: missedMessages,
    turnText: turnInput.text,
    turnMode: turnInput.mode,
    personalRcDm,
    autoAssistEnabled: deps.autoAssistEnabled(),
  });
  const routingPromptText = missedMessages
    .map((message) => message.content)
    .join('\n');
  const registeredGroups = deps.getRegisteredGroups();
  const supervisorRoute = isSupervisorGroup(group.folder)
    ? resolveSupervisorRoute({
        group,
        prompt: routingPromptText,
        registeredGroups,
      })
    : null;
  const effectivePrompt =
    supervisorRoute?.mode === 'collaborate'
      ? `${buildSupervisorRoutingPromptPrefix({
          decision: supervisorRoute,
          registeredGroups,
        })}${prompt}`
      : prompt;

  if (supervisorRoute) {
    logger.info(
      {
        group: group.name,
        mode: supervisorRoute.mode,
        confidence: supervisorRoute.confidence,
        targetGroupFolder: supervisorRoute.targetGroupFolder,
        topScores: supervisorRoute.scoreBreakdown.slice(0, 3).map((entry) => ({
          role: entry.role,
          score: entry.score,
          targetGroupFolder: entry.targetGroupFolder,
        })),
        reason: supervisorRoute.reason,
      },
      'Supervisor route decision',
    );
  }

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

  if (
    supervisorRoute?.mode === 'delegate' &&
    supervisorRoute.targetGroupFolder
  ) {
    const delegated = await tryAutoDelegateSupervisorTurn({
      group,
      chatJid,
      prompt: routingPromptText,
      routingDecision: supervisorRoute,
      queue: deps.queue,
      channels: deps.channels,
      getAvailableGroups: deps.getAvailableGroups,
      getRegisteredGroups: deps.getRegisteredGroups,
    });
    await channel.setTyping?.(chatJid, false);

    if (delegated.status === 'delegated') {
      return true;
    }
  }

  let hadError = false;
  let outputSentToUser = false;

  const output = await runGroupAgent(
    group,
    effectivePrompt,
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
        outputSentToUser = await relayGroupTurnResult({
          result,
          groupName: group.name,
          channels: deps.channels,
          chatJid,
          deliveryDecision,
        });
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
