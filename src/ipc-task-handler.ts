import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

import {
  canAdminAgentDelegate,
  canAdminAgentSpeakAsOwner,
  getAdminAgentProfile,
  hasAdminAgentToolAccess,
  NanoclawToolName,
} from './admin-agents.js';
import { GROUPS_DIR, TIMEZONE } from './config.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isPersonalFolder } from './rc-auto-register.js';
import { formatOnBehalfAssistantMessage } from './on-behalf-message.js';
import { resolveCrossChatRcDelivery } from './rc-delivery-policy.js';
import { isValidGroupFolder, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  NotebookLmAddSourcesResult,
  NotebookLmNotebook,
  NotebookLmSourceInput,
} from './notebooklm.js';
import { AvailableGroup } from './container-contract.js';
import {
  RcContactInput,
  RcPresenceUpdateInput,
} from './channels/ringcentral.js';
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
  extensionId?: string;
  userStatus?: string;
  dndStatus?: string;
  contact?: RcContactInput;
  notebookId?: string;
  title?: string;
  pageSize?: number;
  sources?: NotebookLmSourceInput[];
  onBehalfIntent?: boolean;
  targetGroupFolder?: string;
  context?: string;
}

export interface TaskIpcDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
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
  rcListChatMembers: (
    chatRef: string,
    mode: RcDeliveryMode,
    limit?: number,
  ) => Promise<import('./channels/ringcentral.js').RcChatMember[]>;
  rcGetPresence: (
    mode: RcDeliveryMode,
    extensionId?: string,
  ) => Promise<import('./channels/ringcentral.js').RcPresence>;
  rcSetPresence: (
    mode: RcDeliveryMode,
    update: RcPresenceUpdateInput,
  ) => Promise<import('./channels/ringcentral.js').RcPresence>;
  rcGetExtension: (
    mode: RcDeliveryMode,
    extensionId?: string,
  ) => Promise<import('./channels/ringcentral.js').RcExtensionSummary>;
  rcListExtensions: (
    mode: RcDeliveryMode,
    query?: string,
    limit?: number,
  ) => Promise<import('./channels/ringcentral.js').RcExtensionSummary[]>;
  rcListContacts: (
    mode: RcDeliveryMode,
    query?: string,
    limit?: number,
  ) => Promise<import('./channels/ringcentral.js').RcContact[]>;
  rcCreateContact: (
    mode: RcDeliveryMode,
    contact: RcContactInput,
  ) => Promise<import('./channels/ringcentral.js').RcContact>;
  rcListPhoneNumbers: (
    mode: RcDeliveryMode,
    limit?: number,
  ) => Promise<import('./channels/ringcentral.js').RcPhoneNumber[]>;
  notebookLmListNotebooks: (limit?: number) => Promise<NotebookLmNotebook[]>;
  notebookLmCreateNotebook: (title: string) => Promise<NotebookLmNotebook>;
  notebookLmGetNotebook: (notebookId: string) => Promise<NotebookLmNotebook>;
  notebookLmAddSources: (
    notebookId: string,
    sources: NotebookLmSourceInput[],
    sourceGroup: string,
    isMain: boolean,
  ) => Promise<NotebookLmAddSourcesResult>;
  delegateToGroup: (params: {
    sourceGroupFolder: string;
    targetGroupFolder: string;
    prompt: string;
    context?: string;
  }) => Promise<{
    result: string | null;
    targetRole: string | null;
    postedToTargetGroup?: boolean;
  }>;
}

const RC_IPC_TIMEOUT_MS = 15_000;
const RC_LIST_CHATS_IPC_TIMEOUT_MS = 60_000;

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
  const profile = getAdminAgentProfile(sourceGroup);
  if (!profile) {
    return isMain || isPersonalFolder(sourceGroup, GROUPS_DIR);
  }

  return (
    hasAdminAgentToolAccess(sourceGroup, 'list_rc_chats') ||
    hasAdminAgentToolAccess(sourceGroup, 'read_rc_messages') ||
    hasAdminAgentToolAccess(sourceGroup, 'send_rc_message') ||
    hasAdminAgentToolAccess(sourceGroup, 'send_rc_dm')
  );
}

function hasToolAccess(
  sourceGroup: string,
  tool: NanoclawToolName,
  fallbackAllowed: boolean,
): boolean {
  const profile = getAdminAgentProfile(sourceGroup);
  if (!profile) return fallbackAllowed;
  return hasAdminAgentToolAccess(sourceGroup, tool);
}

function hasGuardedOwnerVoiceAccess(sourceGroup: string): boolean {
  return canAdminAgentSpeakAsOwner(sourceGroup);
}

function resolveRcMode(
  sourceGroup: string,
  requested?: RcDeliveryMode,
  autoDefault: Exclude<RcDeliveryMode, 'auto'> = 'bot',
): RcDeliveryMode {
  if (requested && requested !== 'auto') return requested;
  return sourceGroup === 'rc-personal' ? 'personal' : autoDefault;
}

function resolveRcLookupMode(
  sourceGroup: string,
  requested?: RcDeliveryMode,
  autoDefault: Exclude<RcDeliveryMode, 'auto'> = 'bot',
): RcDeliveryMode {
  if (sourceGroup === 'rc-personal') return 'personal';
  return resolveRcMode(sourceGroup, requested, autoDefault);
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
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
      if (!hasToolAccess(sourceGroup, 'register_group', isMain)) {
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
      if (!hasToolAccess(sourceGroup, 'register_group', isMain)) {
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

    case 'delegate_to_group': {
      if (!data.targetGroupFolder || !data.prompt) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'targetGroupFolder and prompt are required.',
        });
        break;
      }
      if (
        !hasToolAccess(sourceGroup, 'delegate_to_group', false) ||
        !canAdminAgentDelegate(sourceGroup, data.targetGroupFolder)
      ) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: `Delegation from ${sourceGroup} to ${data.targetGroupFolder} is not allowed.`,
        });
        break;
      }
      logger.info(
        {
          sourceGroup,
          targetGroup: data.targetGroupFolder,
          promptLength: data.prompt.length,
          contextLength: data.context?.length ?? 0,
        },
        'IPC delegation request accepted',
      );
      try {
        const result = await deps.delegateToGroup({
          sourceGroupFolder: sourceGroup,
          targetGroupFolder: data.targetGroupFolder,
          prompt: data.prompt,
          context: data.context,
        });
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          targetGroup: data.targetGroupFolder,
          targetRole: result.targetRole,
          result: result.result,
          postedToTargetGroup: result.postedToTargetGroup === true,
        });
      } catch (err) {
        logger.warn(
          {
            sourceGroup,
            targetGroup: data.targetGroupFolder,
            error: err instanceof Error ? err.message : String(err),
          },
          'IPC delegation request failed',
        );
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'rc_list_chats': {
      const mode = resolveRcLookupMode(sourceGroup, data.mode);
      if (
        !hasRcAccess(sourceGroup, isMain) ||
        !hasToolAccess(sourceGroup, 'list_rc_chats', isMain)
      ) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'RC tools are only available from main or personal groups.',
        });
        break;
      }
      try {
        const chats = await withTimeout(
          deps.rcListChats(mode, data.query, data.limit),
          RC_LIST_CHATS_IPC_TIMEOUT_MS,
          'rc_list_chats',
        );
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
      const mode = resolveRcLookupMode(sourceGroup, data.mode);
      const chatRef = data.chatId || data.chatJid;
      if (
        !hasRcAccess(sourceGroup, isMain) ||
        !hasToolAccess(sourceGroup, 'read_rc_messages', isMain)
      ) {
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
        const transcript = await withTimeout(
          deps.rcReadMessages(chatRef, mode, data.limit),
          RC_IPC_TIMEOUT_MS,
          'rc_read_messages',
        );
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
      const chatRef = data.chatId || data.chatJid;
      const deliveryDecision = resolveCrossChatRcDelivery({
        requestedMode: data.mode,
        onBehalfIntent: data.onBehalfIntent === true,
      });
      if (
        !hasRcAccess(sourceGroup, isMain) ||
        !hasToolAccess(sourceGroup, 'send_rc_message', isMain)
      ) {
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
      if (
        deliveryDecision.mode === 'personal' &&
        !hasGuardedOwnerVoiceAccess(sourceGroup)
      ) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'Owner-voice RingCentral sending is restricted to rc-personal.',
        });
        break;
      }
      const outboundText =
        deliveryDecision.mode === 'personal'
          ? formatOnBehalfAssistantMessage(data.text)
          : data.text;
      try {
        const result = await withTimeout(
          deps.rcSendMessage(chatRef, outboundText, deliveryDecision.mode),
          RC_IPC_TIMEOUT_MS,
          'rc_send_message',
        );
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          result,
        });
        logger.info(
          {
            chatRef,
            sourceGroup,
            requestedMode: data.mode || 'auto',
            mode: deliveryDecision.mode,
            onBehalfIntent: data.onBehalfIntent === true,
            policyForced: deliveryDecision.policyForced,
          },
          'Applied host-enforced RingCentral cross-chat delivery policy',
        );
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'rc_list_chat_members': {
      const mode = resolveRcLookupMode(sourceGroup, data.mode);
      const chatRef = data.chatId || data.chatJid;
      if (
        !hasRcAccess(sourceGroup, isMain) ||
        !hasToolAccess(sourceGroup, 'list_rc_chat_members', isMain)
      ) {
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
        const members = await withTimeout(
          deps.rcListChatMembers(chatRef, mode, data.limit),
          RC_IPC_TIMEOUT_MS,
          'rc_list_chat_members',
        );
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          members,
        });
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'rc_get_presence': {
      const mode = resolveRcLookupMode(sourceGroup, data.mode, 'personal');
      if (
        !hasRcAccess(sourceGroup, isMain) ||
        !hasToolAccess(sourceGroup, 'get_rc_presence', isMain)
      ) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'RC tools are only available from main or personal groups.',
        });
        break;
      }
      try {
        const presence = await withTimeout(
          deps.rcGetPresence(mode, data.extensionId),
          RC_IPC_TIMEOUT_MS,
          'rc_get_presence',
        );
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          presence,
        });
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'rc_set_presence': {
      const mode = resolveRcLookupMode(sourceGroup, data.mode, 'personal');
      if (
        !hasRcAccess(sourceGroup, isMain) ||
        !hasToolAccess(sourceGroup, 'set_rc_presence', isMain)
      ) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'RC tools are only available from main or personal groups.',
        });
        break;
      }
      if (!data.userStatus && !data.dndStatus) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'userStatus or dndStatus is required.',
        });
        break;
      }
      try {
        const presence = await withTimeout(
          deps.rcSetPresence(mode, {
            userStatus: data.userStatus,
            dndStatus: data.dndStatus,
          }),
          RC_IPC_TIMEOUT_MS,
          'rc_set_presence',
        );
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          presence,
        });
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'rc_get_extension': {
      const mode = resolveRcLookupMode(sourceGroup, data.mode, 'personal');
      if (
        !hasRcAccess(sourceGroup, isMain) ||
        !hasToolAccess(sourceGroup, 'get_rc_extension', isMain)
      ) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'RC tools are only available from main or personal groups.',
        });
        break;
      }
      try {
        const extension = await withTimeout(
          deps.rcGetExtension(mode, data.extensionId),
          RC_IPC_TIMEOUT_MS,
          'rc_get_extension',
        );
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          extension,
        });
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'rc_list_extensions': {
      const mode = resolveRcLookupMode(sourceGroup, data.mode, 'personal');
      if (
        !hasRcAccess(sourceGroup, isMain) ||
        !hasToolAccess(sourceGroup, 'list_rc_extensions', isMain)
      ) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'RC tools are only available from main or personal groups.',
        });
        break;
      }
      try {
        const extensions = await withTimeout(
          deps.rcListExtensions(mode, data.query, data.limit),
          RC_IPC_TIMEOUT_MS,
          'rc_list_extensions',
        );
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          extensions,
        });
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'rc_list_contacts': {
      const mode = resolveRcLookupMode(sourceGroup, data.mode, 'personal');
      if (
        !hasRcAccess(sourceGroup, isMain) ||
        !hasToolAccess(sourceGroup, 'list_rc_contacts', isMain)
      ) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'RC tools are only available from main or personal groups.',
        });
        break;
      }
      try {
        const contacts = await withTimeout(
          deps.rcListContacts(mode, data.query, data.limit),
          RC_IPC_TIMEOUT_MS,
          'rc_list_contacts',
        );
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          contacts,
        });
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'rc_create_contact': {
      const mode = resolveRcLookupMode(sourceGroup, data.mode, 'personal');
      if (
        !hasRcAccess(sourceGroup, isMain) ||
        !hasToolAccess(sourceGroup, 'create_rc_contact', isMain)
      ) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'RC tools are only available from main or personal groups.',
        });
        break;
      }
      if (!data.contact) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'contact is required.',
        });
        break;
      }
      try {
        const contact = await withTimeout(
          deps.rcCreateContact(mode, data.contact),
          RC_IPC_TIMEOUT_MS,
          'rc_create_contact',
        );
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          contact,
        });
      } catch (err) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'rc_list_phone_numbers': {
      const mode = resolveRcLookupMode(sourceGroup, data.mode, 'personal');
      if (
        !hasRcAccess(sourceGroup, isMain) ||
        !hasToolAccess(sourceGroup, 'list_rc_phone_numbers', isMain)
      ) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'RC tools are only available from main or personal groups.',
        });
        break;
      }
      try {
        const phoneNumbers = await withTimeout(
          deps.rcListPhoneNumbers(mode, data.limit),
          RC_IPC_TIMEOUT_MS,
          'rc_list_phone_numbers',
        );
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: true,
          phoneNumbers,
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
      if (
        !hasToolAccess(sourceGroup, 'list_notebooklm_notebooks', isMain)
      ) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'NotebookLM tools are restricted in this group.',
        });
        break;
      }
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
      if (
        !hasToolAccess(sourceGroup, 'create_notebooklm_notebook', isMain)
      ) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'NotebookLM tools are restricted in this group.',
        });
        break;
      }
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
      if (!hasToolAccess(sourceGroup, 'get_notebooklm_notebook', isMain)) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'NotebookLM tools are restricted in this group.',
        });
        break;
      }
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
      if (!hasToolAccess(sourceGroup, 'add_notebooklm_sources', isMain)) {
        writeTaskResponse(sourceGroup, data.requestId, {
          ok: false,
          error: 'NotebookLM tools are restricted in this group.',
        });
        break;
      }
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
