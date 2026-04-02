import { getAdminAgentProfile, isSupervisorGroup } from './admin-agents.js';
import { AvailableGroup, ContainerOutput } from './container-contract.js';
import { runContainerAgent } from './container-runner.js';
import {
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-snapshots.js';
import { getAllTasks, getSession, setSession } from './db.js';
import { isMainGroup, isPersonalModeGroup } from './group-access.js';
import { logger } from './logger.js';
import { formatOutbound } from './router.js';
import { RegisteredGroup } from './types.js';
import { GroupQueue } from './group-queue.js';

function buildDelegationPrompt(params: {
  sourceGroup: string;
  targetRole: string;
  prompt: string;
  context?: string;
}): string {
  const lines = [
    `[INTERNAL ADMIN DELEGATION]`,
    `Source group: ${params.sourceGroup}`,
    `Your specialist role: ${params.targetRole}`,
    `This is an internal specialist-to-specialist delegation, not a user-visible turn.`,
    `Produce the final specialist result text only. The host may deliver it to the relevant admin team chat.`,
    `Do not use send_message, send_rc_message, send_rc_dm, or owner-voice communication unless the task explicitly requires it and your policy allows it.`,
    ``,
    `Task:`,
    params.prompt,
  ];

  if (params.context?.trim()) {
    lines.push('', 'Additional context:', params.context.trim());
  }

  return `${lines.join('\n')}\n`;
}

export function resolveDelegationDelivery(params: {
  sourceGroupFolder: string;
  sourceGroupName?: string;
  targetGroupName: string;
  prompt: string;
  result: string | null;
}): {
  postToTargetChat: boolean;
  targetChatText: string | null;
  callerResult: string | null;
  postedToTargetGroup: boolean;
} {
  const cleanedResult = formatOutbound(params.result ?? '');
  if (!cleanedResult) {
    return {
      postToTargetChat: false,
      targetChatText: null,
      callerResult: params.result,
      postedToTargetGroup: false,
    };
  }

  if (!isSupervisorGroup(params.sourceGroupFolder)) {
    return {
      postToTargetChat: false,
      targetChatText: null,
      callerResult: cleanedResult,
      postedToTargetGroup: false,
    };
  }

  const sourceLabel =
    params.sourceGroupName?.trim() || params.sourceGroupFolder;
  const trimmedPrompt = params.prompt.trim();
  const headerLines = [`[Delegated from ${sourceLabel}]`];
  if (trimmedPrompt) {
    headerLines.push(`Task: ${trimmedPrompt}`);
  }

  return {
    postToTargetChat: true,
    targetChatText: `${headerLines.join('\n')}\n\n${cleanedResult}`,
    callerResult:
      `The delegated result has already been posted in ${params.targetGroupName}. ` +
      'Do not send any additional RingCentral message to that team for this task. ' +
      'If you reply here, keep it to a brief acknowledgment only.',
    postedToTargetGroup: true,
  };
}

export async function delegateToAdminGroup(params: {
  sourceGroupFolder: string;
  targetGroupJid: string;
  targetGroup: RegisteredGroup;
  queue: GroupQueue;
  getAvailableGroups: () => AvailableGroup[];
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  prompt: string;
  context?: string;
}): Promise<{ result: string | null; targetRole: string | null }> {
  const delegationId = `deleg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const adminProfile = getAdminAgentProfile(params.targetGroup.folder);
  const targetRole = adminProfile?.role ?? null;
  const isMain = isMainGroup(params.targetGroup);

  logger.info(
    {
      delegationId,
      sourceGroup: params.sourceGroupFolder,
      targetGroup: params.targetGroup.folder,
      targetRole,
      promptLength: params.prompt.length,
      contextLength: params.context?.length ?? 0,
    },
    'Admin delegation started',
  );

  const tasks = getAllTasks();
  writeTasksSnapshot(
    params.targetGroup.folder,
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
    params.targetGroup.folder,
    isMain,
    params.getAvailableGroups(),
    new Set(Object.keys(params.getRegisteredGroups())),
  );

  let lastResult: string | null = null;
  let runError: string | null = null;
  let closeRequested = false;

  await new Promise<void>((resolve) => {
    const taskId = `delegate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    params.queue.enqueueTask(params.targetGroupJid, taskId, async () => {
      logger.info(
        {
          delegationId,
          taskId,
          sourceGroup: params.sourceGroupFolder,
          targetGroup: params.targetGroup.folder,
          targetRole,
        },
        'Admin delegation queued on specialist agent',
      );

      const output = await runContainerAgent(
        params.targetGroup,
        {
          prompt: buildDelegationPrompt({
            sourceGroup: params.sourceGroupFolder,
            targetRole: targetRole || 'specialist',
            prompt: params.prompt,
            context: params.context,
          }),
          sessionId: getSession(params.targetGroup.folder),
          groupFolder: params.targetGroup.folder,
          chatJid: params.targetGroupJid,
          isMain,
          personalMode: isPersonalModeGroup(params.targetGroup),
          adminRole: adminProfile?.role,
          canSpeakAsOwner: adminProfile?.canSpeakAsOwner,
          allowedExternalMcpCapabilities:
            adminProfile?.externalMcpCapabilities ?? [],
          allowedNanoclawTools: adminProfile?.nanoclawTools ?? [],
          allowedPeerGroups: adminProfile?.allowedPeers ?? [],
          disableCurrentChatSendTool: true,
        },
        (proc, containerName) => {
          logger.info(
            {
              delegationId,
              taskId,
              sourceGroup: params.sourceGroupFolder,
              targetGroup: params.targetGroup.folder,
              targetRole,
              containerName,
            },
            'Admin delegation specialist container started',
          );
          params.queue.registerProcess(
            params.targetGroupJid,
            proc,
            containerName,
            params.targetGroup.folder,
          );
        },
        async (streamedOutput: ContainerOutput) => {
          if (streamedOutput.result) {
            lastResult = streamedOutput.result;
            logger.info(
              {
                delegationId,
                taskId,
                targetGroup: params.targetGroup.folder,
                targetRole,
                resultLength: streamedOutput.result.length,
              },
              'Admin delegation received specialist result',
            );
          }
          if (streamedOutput.newSessionId) {
            setSession(params.targetGroup.folder, streamedOutput.newSessionId);
          }
          if (streamedOutput.status === 'error') {
            runError = streamedOutput.error || 'Delegated turn failed';
            logger.warn(
              {
                delegationId,
                taskId,
                targetGroup: params.targetGroup.folder,
                targetRole,
                error: runError,
              },
              'Admin delegation specialist run failed',
            );
          }
          if (
            !closeRequested &&
            (streamedOutput.lifecycle === 'idle_waiting' ||
              streamedOutput.result ||
              streamedOutput.status === 'error')
          ) {
            closeRequested = true;
            setTimeout(() => {
              params.queue.closeStdin(params.targetGroupJid);
            }, 500);
          }
        },
      );

      if (output.newSessionId) {
        setSession(params.targetGroup.folder, output.newSessionId);
      }
      if (output.status === 'error') {
        runError = output.error || 'Delegated turn failed';
      }

      resolve();
    });
  });

  if (runError) {
    logger.warn(
      {
        delegationId,
        sourceGroup: params.sourceGroupFolder,
        targetGroup: params.targetGroup.folder,
        targetRole,
        durationMs: Date.now() - startedAt,
        error: runError,
      },
      'Admin-agent delegation failed',
    );
    throw new Error(runError);
  }

  const resultLength = lastResult == null ? 0 : String(lastResult).length;

  logger.info(
    {
      delegationId,
      sourceGroup: params.sourceGroupFolder,
      targetGroup: params.targetGroup.folder,
      targetRole,
      durationMs: Date.now() - startedAt,
      resultLength,
    },
    'Admin delegation completed',
  );

  return { result: lastResult, targetRole };
}
