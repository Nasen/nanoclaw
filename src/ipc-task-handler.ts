import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isPersonalFolder } from './rc-auto-register.js';
import { isValidGroupFolder, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  NotebookLmAddSourcesResult,
  NotebookLmNotebook,
  NotebookLmSourceInput,
} from './notebooklm.js';
import { RcDeliveryMode, RegisteredGroup } from './types.js';

export interface TaskIpcData {
  type: string;
  taskId?: string;
  prompt?: string;
  schedule_type?: string;
  schedule_value?: string;
  context_mode?: string;
  groupFolder?: string;
  chatJid?: string;
  targetJid?: string;
  jid?: string;
  name?: string;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  containerConfig?: RegisteredGroup['containerConfig'];
  requestId?: string;
  mode?: RcDeliveryMode;
  query?: string;
  limit?: number;
  text?: string;
  chatId?: string;
  notebookId?: string;
  title?: string;
  pageSize?: number;
  sources?: NotebookLmSourceInput[];
}

export interface TaskIpcDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => import('./container-runner.js').AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: import('./container-runner.js').AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  rcListChats: (
    mode: RcDeliveryMode,
    query?: string,
    limit?: number,
  ) => Promise<import('./channels/ringcentral.js').RcChatSummary[]>;
  rcReadMessages: (
    chatRef: string,
    mode: RcDeliveryMode,
    limit?: number,
  ) => Promise<import('./channels/ringcentral.js').RcChatTranscript>;
  rcSendMessage: (
    chatRef: string,
    text: string,
    mode: RcDeliveryMode,
  ) => Promise<{ jid: string; chatId: string; postId?: string }>;
  notebookLmListNotebooks: (limit?: number) => Promise<NotebookLmNotebook[]>;
  notebookLmCreateNotebook: (title: string) => Promise<NotebookLmNotebook>;
  notebookLmGetNotebook: (notebookId: string) => Promise<NotebookLmNotebook>;
  notebookLmAddSources: (
    notebookId: string,
    sources: NotebookLmSourceInput[],
    sourceGroup: string,
    isMain: boolean,
  ) => Promise<NotebookLmAddSourcesResult>;
}

function computeNextRun(
  scheduleType: 'cron' | 'interval' | 'once',
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(scheduleValue, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) {
      throw new Error('Invalid interval');
    }
    return new Date(Date.now() + ms).toISOString();
  }

  const date = new Date(scheduleValue);
  if (isNaN(date.getTime())) {
    throw new Error('Invalid timestamp');
  }
  return date.toISOString();
}

function isTaskAuthorized(
  isMain: boolean,
  sourceGroup: string,
  taskGroupFolder: string,
): boolean {
  return isMain || taskGroupFolder === sourceGroup;
}

function hasRcAccess(sourceGroup: string, isMain: boolean): boolean {
  return isMain || isPersonalFolder(sourceGroup, GROUPS_DIR);
}

function resolveRcMode(
  sourceGroup: string,
  requested?: RcDeliveryMode,
): RcDeliveryMode {
  if (requested && requested !== 'auto') return requested;
  return sourceGroup === 'rc-personal' ? 'personal' : 'bot';
}

function writeTaskResponse(
  sourceGroup: string,
  requestId: string | undefined,
  payload: object,
): void {
  if (!requestId) return;
  const responsesDir = path.join(resolveGroupIpcPath(sourceGroup), 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  const filePath = path.join(responsesDir, `${requestId}.json`);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, filePath);
}

export async function processTaskIpc(
  data: TaskIpcData,
  sourceGroup: string,
  isMain: boolean,
  deps: TaskIpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task': {
      if (
        !data.prompt ||
        !data.schedule_type ||
        !data.schedule_value ||
        !data.targetJid
      ) {
        break;
      }

      const targetGroup = registeredGroups[data.targetJid];
      if (!targetGroup) {
        logger.warn(
          { targetJid: data.targetJid },
          'Cannot schedule task: target group not registered',
        );
        break;
      }

      if (!isTaskAuthorized(isMain, sourceGroup, targetGroup.folder)) {
        logger.warn(
          { sourceGroup, targetFolder: targetGroup.folder },
          'Unauthorized schedule_task attempt blocked',
        );
        break;
      }

      const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';
      let nextRun: string | null = null;
      try {
        nextRun = computeNextRun(scheduleType, data.schedule_value);
      } catch (err) {
        logger.warn(
          { scheduleValue: data.schedule_value, err },
          'Invalid task schedule',
        );
        break;
      }

      const taskId =
        data.taskId ||
        `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const contextMode =
        data.context_mode === 'group' || data.context_mode === 'isolated'
          ? data.context_mode
          : 'isolated';

      createTask({
        id: taskId,
        group_folder: targetGroup.folder,
        chat_jid: data.targetJid,
        prompt: data.prompt,
        schedule_type: scheduleType,
        schedule_value: data.schedule_value,
        context_mode: contextMode,
        next_run: nextRun,
        status: 'active',
        created_at: new Date().toISOString(),
      });
      logger.info(
        { taskId, sourceGroup, targetFolder: targetGroup.folder, contextMode },
        'Task created via IPC',
      );
      break;
    }

    case 'pause_task':
    case 'resume_task':
    case 'cancel_task': {
      if (!data.taskId) break;
      const task = getTaskById(data.taskId);
      if (!task || !isTaskAuthorized(isMain, sourceGroup, task.group_folder)) {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          `Unauthorized task ${data.type} attempt`,
        );
        break;
      }

      if (data.type === 'pause_task') {
        updateTask(data.taskId, { status: 'paused' });
        logger.info(
          { taskId: data.taskId, sourceGroup },
          'Task paused via IPC',
        );
      } else if (data.type === 'resume_task') {
        updateTask(data.taskId, { status: 'active' });
        logger.info(
          { taskId: data.taskId, sourceGroup },
          'Task resumed via IPC',
        );
      } else {
        deleteTask(data.taskId);
        logger.info(
          { taskId: data.taskId, sourceGroup },
          'Task cancelled via IPC',
        );
      }
      break;
    }

    case 'update_task': {
      if (!data.taskId) break;
      const task = getTaskById(data.taskId);
      if (!task) {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          'Task not found for update',
        );
        break;
      }
      if (!isTaskAuthorized(isMain, sourceGroup, task.group_folder)) {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          'Unauthorized task update attempt',
        );
        break;
      }

      const updates: Parameters<typeof updateTask>[1] = {};
      if (data.prompt !== undefined) updates.prompt = data.prompt;
      if (data.schedule_type !== undefined) {
        updates.schedule_type = data.schedule_type as
          | 'cron'
          | 'interval'
          | 'once';
      }
      if (data.schedule_value !== undefined) {
        updates.schedule_value = data.schedule_value;
      }

      if (data.schedule_type || data.schedule_value) {
        const updatedTask = { ...task, ...updates };
        try {
          updates.next_run = computeNextRun(
            updatedTask.schedule_type,
            updatedTask.schedule_value,
          );
        } catch (err) {
          logger.warn(
            { taskId: data.taskId, value: updatedTask.schedule_value, err },
            'Invalid schedule in task update',
          );
          break;
        }
      }

      updateTask(data.taskId, updates);
      logger.info(
        { taskId: data.taskId, sourceGroup, updates },
        'Task updated via IPC',
      );
      break;
    }

    case 'refresh_groups':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
        break;
      }
      logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
      await deps.syncGroups(true);
      deps.writeGroupsSnapshot(
        sourceGroup,
        true,
        deps.getAvailableGroups(),
        new Set(Object.keys(registeredGroups)),
      );
      break;

    case 'register_group':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (!data.jid || !data.name || !data.folder || !data.trigger) {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
        break;
      }
      if (!isValidGroupFolder(data.folder)) {
        logger.warn(
          { sourceGroup, folder: data.folder },
          'Invalid register_group request - unsafe folder name',
        );
        break;
      }
      deps.registerGroup(data.jid, {
        name: data.name,
        folder: data.folder,
        trigger: data.trigger,
        added_at: new Date().toISOString(),
        containerConfig: data.containerConfig,
        requiresTrigger: data.requiresTrigger,
      });
      break;

    case 'rc_list_chats': {
      const mode = resolveRcMode(sourceGroup, data.mode);
      if (!hasRcAccess(sourceGroup, isMain)) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'RC tools are only available from main or personal groups.',
        });
        break;
      }
      try {
        const chats = await deps.rcListChats(mode, data.query, data.limit);
        writeTaskResponse(sourceGroup, data.requestId, { ok: true, chats });
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'rc_read_messages': {
      const mode = resolveRcMode(sourceGroup, data.mode);
      const chatRef = data.chatId || data.chatJid;
      if (!hasRcAccess(sourceGroup, isMain)) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'RC tools are only available from main or personal groups.',
        });
        break;
      }
      if (!chatRef) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'chatId is required.',
        });
        break;
      }
      try {
        const transcript = await deps.rcReadMessages(chatRef, mode, data.limit);
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          transcript,
        });
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'rc_send_message': {
      const mode = resolveRcMode(sourceGroup, data.mode);
      const chatRef = data.chatId || data.chatJid;
      if (!hasRcAccess(sourceGroup, isMain)) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'RC tools are only available from main or personal groups.',
        });
        break;
      }
      if (!chatRef || !data.text) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'chatId and text are required.',
        });
        break;
      }
      try {
        const result = await deps.rcSendMessage(chatRef, data.text, mode);
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          result,
        });
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'notebooklm_list_notebooks': {
      try {
        const notebooks = await deps.notebookLmListNotebooks(data.pageSize);
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          notebooks,
        });
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'notebooklm_create_notebook': {
      if (!data.title) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'title is required.',
        });
        break;
      }
      try {
        const notebook = await deps.notebookLmCreateNotebook(data.title);
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          notebook,
        });
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'notebooklm_get_notebook': {
      if (!data.notebookId) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'notebookId is required.',
        });
        break;
      }
      try {
        const notebook = await deps.notebookLmGetNotebook(data.notebookId);
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          notebook,
        });
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'notebooklm_add_sources': {
      if (!data.notebookId || !data.sources?.length) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'notebookId and sources are required.',
        });
        break;
      }
      try {
        const result = await deps.notebookLmAddSources(
          data.notebookId,
          data.sources,
          sourceGroup,
          isMain,
        );
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          result,
        });
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }
    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
