import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }

    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

function logInvalidGroupFolder(
  task: ScheduledTask,
  startTime: number,
  error: string,
): void {
  updateTask(task.id, { status: 'paused' });
  logger.error(
    { taskId: task.id, groupFolder: task.group_folder, error },
    'Task has invalid group folder',
  );
  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    status: 'error',
    result: null,
    error,
  });
}

function logMissingGroup(task: ScheduledTask, startTime: number): void {
  logger.error(
    { taskId: task.id, groupFolder: task.group_folder },
    'Group not found for task',
  );
  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    status: 'error',
    result: null,
    error: `Group not found: ${task.group_folder}`,
  });
}

function writeTaskContextSnapshot(
  task: ScheduledTask,
  group: RegisteredGroup,
): void {
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((currentTask) => ({
      id: currentTask.id,
      groupFolder: currentTask.group_folder,
      prompt: currentTask.prompt,
      schedule_type: currentTask.schedule_type,
      schedule_value: currentTask.schedule_value,
      status: currentTask.status,
      next_run: currentTask.next_run,
    })),
  );
}

function createCloseSchedulerTaskContainer(
  task: ScheduledTask,
  queue: GroupQueue,
): {
  scheduleClose: () => void;
  clearCloseTimer: () => void;
} {
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    scheduleClose: () => {
      if (closeTimer) return;
      closeTimer = setTimeout(() => {
        logger.debug(
          { taskId: task.id },
          'Closing task container after result',
        );
        queue.closeStdin(task.chat_jid);
      }, TASK_CLOSE_DELAY_MS);
    },
    clearCloseTimer: () => {
      if (closeTimer) clearTimeout(closeTimer);
    },
  };
}

export async function runScheduledTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;

  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logInvalidGroupFolder(task, startTime, error);
    return;
  }

  fs.mkdirSync(groupDir, { recursive: true });
  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const group = Object.values(deps.registeredGroups()).find(
    (registeredGroup) => registeredGroup.folder === task.group_folder,
  );
  if (!group) {
    logMissingGroup(task, startTime);
    return;
  }

  writeTaskContextSnapshot(task, group);

  let result: string | null = null;
  let error: string | null = null;
  const sessionId =
    task.context_mode === 'group'
      ? deps.getSessions()[task.group_folder]
      : undefined;
  const { scheduleClose, clearCloseTimer } = createCloseSchedulerTaskContainer(
    task,
    deps.queue,
  );

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain: group.isMain === true,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    clearCloseTimer();

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    clearCloseTimer();
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;
  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}
