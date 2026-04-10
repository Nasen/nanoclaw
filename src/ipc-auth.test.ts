import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessageDirect,
} from './db.js';
import { processTaskIpc } from './ipc.js';
import type { IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// Set up registered groups used across tests
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
      // Mock the fs.mkdirSync that registerGroup does
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    rcListChats: async () => [],
    rcReadMessages: async () => ({
      jid: 'rc:1',
      chatId: '1',
      name: 'Test',
      messages: [],
    }),
    rcSendMessage: async () => ({ jid: 'rc:1', chatId: '1' }),
    rcListChatMembers: async () => [],
    rcGetPresence: async () => ({ userStatus: 'Available' }),
    rcSetPresence: async (mode, update) => ({
      extensionId: mode,
      ...update,
    }),
    rcGetExtension: async (mode, extensionId) => ({
      id: extensionId ?? 'self',
      name: mode,
    }),
    rcListExtensions: async () => [],
    rcListContacts: async () => [],
    rcCreateContact: async (mode, contact) => ({
      id: 'contact-1',
      firstName: mode,
      ...contact,
    }),
    rcListPhoneNumbers: async () => [],
    notebookLmListNotebooks: async () => [],
    notebookLmCreateNotebook: async (title) => ({
      notebookId: 'nb-1',
      title,
    }),
    notebookLmGetNotebook: async (notebookId) => ({
      notebookId,
      title: 'Notebook',
    }),
    notebookLmAddSources: async () => ({
      createdSources: [],
      uploadedFiles: [],
    }),
    delegateToGroup: async () => ({
      result: 'delegated result',
      targetRole: 'specialist',
    }),
  };

  fs.rmSync(path.join(DATA_DIR, 'ipc'), { recursive: true, force: true });
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify task was created in DB for the other group
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'unknown@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-other',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can pause any task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-main' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'third-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-to-cancel' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-own' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-foreign' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-foreign')).toBeDefined();
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'other-group',
      false,
      deps,
    );

    // registeredGroups should not have changed
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, RegisteredGroup>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(
      isMessageAuthorized('whatsapp_main', true, 'other@g.us', groups),
    ).toBe(true);
    expect(
      isMessageAuthorized('whatsapp_main', true, 'third@g.us', groups),
    ).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(
      isMessageAuthorized('other-group', false, 'other@g.us', groups),
    ).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('other-group', false, 'main@g.us', groups)).toBe(
      false,
    );
    expect(
      isMessageAuthorized('other-group', false, 'third@g.us', groups),
    ).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(
      isMessageAuthorized('other-group', false, 'unknown@g.us', groups),
    ).toBe(false);
  });

  it('main group can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(
      isMessageAuthorized('whatsapp_main', true, 'unknown@g.us', groups),
    ).toBe(true);
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // every day at 9am
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
  });

  it('rejects invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000', // 1 hour
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    // next_run should be ~1 hour from now
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'zero interval',
        schedule_type: 'interval',
        schedule_value: '0',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'group',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'bogus' as any,
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_group success path ---

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify group was registered in DB
    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Andy');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // missing folder and trigger
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });
});

describe('RingCentral IPC handlers', () => {
  it('defaults account-level RC requests to personal mode', async () => {
    const getPresence = vi.fn(async () => ({ userStatus: 'Available' }));
    deps.rcGetPresence = getPresence;

    await processTaskIpc(
      {
        type: 'rc_get_presence',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getPresence).toHaveBeenCalledWith('personal', undefined);
  });

  it('keeps chat-level RC requests on bot mode by default outside rc-personal', async () => {
    const listMembers = vi.fn(async () => []);
    deps.rcListChatMembers = listMembers;

    await processTaskIpc(
      {
        type: 'rc_list_chat_members',
        chatId: '12345',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(listMembers).toHaveBeenCalledWith('12345', 'bot', undefined);
  });

  it('defaults rc_send_message to bot mode in rc-personal', async () => {
    const sendMessage = vi.fn(async () => ({
      jid: 'rc:12345',
      chatId: '12345',
    }));
    deps.rcSendMessage = sendMessage;

    await processTaskIpc(
      {
        type: 'rc_send_message',
        chatId: '12345',
        text: 'hello',
        requestId: 'req-1',
      },
      'rc-personal',
      false,
      deps,
    );

    expect(sendMessage).toHaveBeenCalledWith('12345', 'hello', 'bot');
  });

  it('honors explicit personal rc_send_message mode in rc-personal', async () => {
    const sendMessage = vi.fn(async () => ({
      jid: 'rc:12345',
      chatId: '12345',
    }));
    deps.rcSendMessage = sendMessage;

    await processTaskIpc(
      {
        type: 'rc_send_message',
        chatId: '12345',
        text: 'hello',
        mode: 'personal',
        onBehalfIntent: true,
        requestId: 'req-2',
      },
      'rc-personal',
      false,
      deps,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      '12345',
      "[On Nasen's behalf] hello",
      'personal',
    );
  });

  it('honors explicit personal rc_send_message mode without host downgrade', async () => {
    const sendMessage = vi.fn(async () => ({
      jid: 'rc:12345',
      chatId: '12345',
    }));
    deps.rcSendMessage = sendMessage;

    await processTaskIpc(
      {
        type: 'rc_send_message',
        chatId: '12345',
        text: 'hello',
        mode: 'personal',
        requestId: 'req-3',
      },
      'rc-personal',
      false,
      deps,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      '12345',
      "[On Nasen's behalf] hello",
      'personal',
    );
  });

  it('forwards contact payloads to RC contact creation', async () => {
    const createContact = vi.fn(async () => ({ id: 'contact-1' }));
    deps.rcCreateContact = createContact;

    await processTaskIpc(
      {
        type: 'rc_create_contact',
        contact: {
          firstName: 'Jane',
          lastName: 'Doe',
          email: 'jane@example.com',
        },
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(createContact).toHaveBeenCalledWith('personal', {
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
    });
  });

  it('blocks RC account tools from non-main, non-personal groups', async () => {
    const getExtension = vi.fn(async () => ({ id: '101' }));
    deps.rcGetExtension = getExtension;

    await processTaskIpc(
      {
        type: 'rc_get_extension',
        extensionId: '101',
      },
      'other-group',
      false,
      deps,
    );

    expect(getExtension).not.toHaveBeenCalled();
  });

  it('writes a timeout error response when an RC IPC request stalls', async () => {
    vi.useFakeTimers();
    try {
      deps.rcListChats = vi.fn(async () => await new Promise<never>(() => {}));

      const requestId = 'timeout-rc-list-chats';
      const taskPromise = processTaskIpc(
        {
          type: 'rc_list_chats',
          requestId,
          query: 'Jupiter + NC CI Status',
        },
        'whatsapp_main',
        true,
        deps,
      );

      await vi.advanceTimersByTimeAsync(60_000);
      await taskPromise;

      const responsePath = path.join(
        DATA_DIR,
        'ipc',
        'whatsapp_main',
        'responses',
        `${requestId}.json`,
      );
      const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
        ok: boolean;
        error?: string;
      };

      expect(response.ok).toBe(false);
      expect(response.error).toContain('rc_list_chats timed out after 60000ms');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Admin specialist IPC policy', () => {
  it('allows delegation to a whitelisted peer specialist', async () => {
    const delegateToGroup = vi.fn(async () => ({
      result: 'delegated result',
      targetRole: 'jiraops',
    }));
    deps.delegateToGroup = delegateToGroup;

    await processTaskIpc(
      {
        type: 'delegate_to_group',
        targetGroupFolder: 'rc-grp-nanoclaw-jiraops',
        prompt: 'Create a Jira issue summary',
        requestId: 'delegate-ok',
      },
      'rc-grp-nanoclaw-gitops',
      true,
      deps,
    );

    expect(delegateToGroup).toHaveBeenCalledWith({
      sourceGroupFolder: 'rc-grp-nanoclaw-gitops',
      targetGroupFolder: 'rc-grp-nanoclaw-jiraops',
      prompt: 'Create a Jira issue summary',
      context: undefined,
    });

    const responsePath = path.join(
      DATA_DIR,
      'ipc',
      'rc-grp-nanoclaw-gitops',
      'responses',
      'delegate-ok.json',
    );
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
      ok: boolean;
      targetRole?: string;
      result?: string;
    };

    expect(response).toMatchObject({
      ok: true,
      targetRole: 'jiraops',
      result: 'delegated result',
    });
  });

  it('blocks delegation to a non-whitelisted peer specialist', async () => {
    const delegateToGroup = vi.fn(async () => ({
      result: 'delegated result',
      targetRole: 'gitops',
    }));
    deps.delegateToGroup = delegateToGroup;

    await processTaskIpc(
      {
        type: 'delegate_to_group',
        targetGroupFolder: 'rc-grp-nanoclaw-gitops',
        prompt: 'Review this repository state',
        requestId: 'delegate-blocked',
      },
      'rc-grp-nanoclaw-peopleops',
      true,
      deps,
    );

    expect(delegateToGroup).not.toHaveBeenCalled();

    const responsePath = path.join(
      DATA_DIR,
      'ipc',
      'rc-grp-nanoclaw-peopleops',
      'responses',
      'delegate-blocked.json',
    );
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
      ok: boolean;
      error?: string;
    };

    expect(response.ok).toBe(false);
    expect(response.error).toContain('is not allowed');
  });

  it('blocks supervisor-only register_group from specialist admin teams', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'specialist-new@g.us',
        name: 'Blocked Group',
        folder: 'blocked-group',
        trigger: '@NanoClaw',
      },
      'rc-grp-nanoclaw-gitops',
      true,
      deps,
    );

    expect(getRegisteredGroup('specialist-new@g.us')).toBeUndefined();
  });
});

describe('NotebookLM IPC handlers', () => {
  it('creates a notebook through the host NotebookLM service', async () => {
    const createNotebook = vi.fn(async (title: string) => ({
      notebookId: 'nb-created',
      title,
    }));
    deps.notebookLmCreateNotebook = createNotebook;

    await processTaskIpc(
      {
        type: 'notebooklm_create_notebook',
        title: 'Research Notes',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(createNotebook).toHaveBeenCalledWith('Research Notes');
  });

  it('adds NotebookLM sources for a supervisor-capable group', async () => {
    const addSources = vi.fn(async () => ({
      createdSources: [],
      uploadedFiles: [],
    }));
    deps.notebookLmAddSources = addSources;

    await processTaskIpc(
      {
        type: 'notebooklm_add_sources',
        notebookId: 'nb-1',
        sources: [{ type: 'text', text: 'hello' }],
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(addSources).toHaveBeenCalledWith(
      'nb-1',
      [{ type: 'text', text: 'hello' }],
      'whatsapp_main',
      true,
    );
  });

  it('blocks NotebookLM sources from non-admin groups', async () => {
    const addSources = vi.fn(async () => ({
      createdSources: [],
      uploadedFiles: [],
    }));
    deps.notebookLmAddSources = addSources;

    await processTaskIpc(
      {
        type: 'notebooklm_add_sources',
        notebookId: 'nb-1',
        sources: [{ type: 'text', text: 'hello' }],
        requestId: 'nb-blocked',
      },
      'other-group',
      false,
      deps,
    );

    expect(addSources).not.toHaveBeenCalled();

    const responsePath = path.join(
      DATA_DIR,
      'ipc',
      'other-group',
      'responses',
      'nb-blocked.json',
    );
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
      ok: boolean;
      error?: string;
    };

    expect(response.ok).toBe(false);
    expect(response.error).toContain('NotebookLM tools are restricted');
  });
});

describe('Durable memory IPC handler', () => {
  it('writes bounded durable memory into the current group folder', async () => {
    const groupDir = path.join(process.cwd(), 'groups', 'whatsapp_main');
    fs.mkdirSync(groupDir, { recursive: true });

    try {
      await processTaskIpc(
        {
          type: 'manage_memory',
          target: 'memory',
          title: 'Deploy rule',
          content: 'Rebuild the exact CONTAINER_IMAGE tag before restart.',
          requestId: 'memory-write',
        },
        'whatsapp_main',
        true,
        deps,
      );

      const filePath = path.join(groupDir, 'MEMORY.md');
      const responsePath = path.join(
        DATA_DIR,
        'ipc',
        'whatsapp_main',
        'responses',
        'memory-write.json',
      );
      const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
        ok: boolean;
        fileName?: string;
        updated?: boolean;
      };

      expect(fs.readFileSync(filePath, 'utf-8')).toContain(
        '**Deploy rule**: Rebuild the exact CONTAINER_IMAGE tag before restart.',
      );
      expect(response).toMatchObject({
        ok: true,
        fileName: 'MEMORY.md',
        updated: true,
      });
    } finally {
      fs.rmSync(path.join(groupDir, 'MEMORY.md'), { force: true });
      fs.rmSync(path.join(groupDir, 'USER.md'), { force: true });
    }
  });

  it('blocks durable memory writes from groups without tool access', async () => {
    await processTaskIpc(
      {
        type: 'manage_memory',
        target: 'memory',
        title: 'Blocked',
        content: 'This should not be written.',
        requestId: 'memory-blocked',
      },
      'other-group',
      false,
      deps,
    );

    const response = JSON.parse(
      fs.readFileSync(
        path.join(
          DATA_DIR,
          'ipc',
          'other-group',
          'responses',
          'memory-blocked.json',
        ),
        'utf-8',
      ),
    ) as { ok: boolean; error?: string };

    expect(response.ok).toBe(false);
    expect(response.error).toContain('manage_memory');
  });
});

describe('Search and runbook IPC handlers', () => {
  it('searches current-group memory and archived sessions after indexing', async () => {
    const groupDir = path.join(process.cwd(), 'groups', 'whatsapp_main');
    const conversationsDir = path.join(groupDir, 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'MEMORY.md'),
      '# MEMORY\n\n- [2026-04-10T00:00:00.000Z] **Deploy rule**: Rebuild the exact container image tag before restart.\n',
    );
    fs.writeFileSync(
      path.join(conversationsDir, '2026-04-10-rollout.md'),
      '# Rollout Discussion\n\nWe investigated a deploy rollback after image drift.\n',
    );

    try {
      await processTaskIpc(
        {
          type: 'search_memory',
          query: 'container image',
          requestId: 'memory-search',
        },
        'whatsapp_main',
        true,
        deps,
      );

      await processTaskIpc(
        {
          type: 'search_sessions',
          query: 'deploy rollback',
          requestId: 'session-search',
        },
        'whatsapp_main',
        true,
        deps,
      );

      const memoryResponse = JSON.parse(
        fs.readFileSync(
          path.join(
            DATA_DIR,
            'ipc',
            'whatsapp_main',
            'responses',
            'memory-search.json',
          ),
          'utf-8',
        ),
      ) as {
        ok: boolean;
        results?: Array<{ doc_type: string; title: string }>;
      };
      const sessionResponse = JSON.parse(
        fs.readFileSync(
          path.join(
            DATA_DIR,
            'ipc',
            'whatsapp_main',
            'responses',
            'session-search.json',
          ),
          'utf-8',
        ),
      ) as {
        ok: boolean;
        results?: Array<{ doc_type: string; title: string }>;
      };

      expect(memoryResponse.ok).toBe(true);
      expect(memoryResponse.results?.[0]?.doc_type).toBe('memory');
      expect(sessionResponse.ok).toBe(true);
      expect(sessionResponse.results?.[0]?.doc_type).toBe('conversation');
    } finally {
      fs.rmSync(path.join(groupDir, 'MEMORY.md'), { force: true });
      fs.rmSync(path.join(conversationsDir, '2026-04-10-rollout.md'), {
        force: true,
      });
      fs.rmSync(conversationsDir, { recursive: true, force: true });
    }
  });

  it('searches the current chat history through FTS', async () => {
    storeChatMetadata(
      'main@g.us',
      '2026-04-10T00:00:00.000Z',
      'Main Group Chat',
    );
    storeMessageDirect({
      id: 'history-1',
      chat_jid: 'main@g.us',
      sender: 'alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'Please rebuild the exact container image tag before restart.',
      timestamp: '2026-04-10T00:00:01.000Z',
      is_from_me: false,
    });

    await processTaskIpc(
      {
        type: 'search_group_history',
        query: 'container image',
        requestId: 'history-search',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const response = JSON.parse(
      fs.readFileSync(
        path.join(
          DATA_DIR,
          'ipc',
          'whatsapp_main',
          'responses',
          'history-search.json',
        ),
        'utf-8',
      ),
    ) as {
      ok: boolean;
      chatJid?: string;
      results?: Array<{ content: string }>;
    };

    expect(response.ok).toBe(true);
    expect(response.chatJid).toBe('main@g.us');
    expect(response.results?.[0]?.content).toContain('container image tag');
  });

  it('writes runbooks and skill-candidate drafts for the current group', async () => {
    const groupDir = path.join(process.cwd(), 'groups', 'whatsapp_main');
    const runbooksDir = path.join(groupDir, 'runbooks');

    try {
      await processTaskIpc(
        {
          type: 'manage_runbook',
          kind: 'skill_candidate',
          title: 'Deploy recovery',
          summary: 'Draft steps for deploy rollback investigation.',
          content:
            '1. Verify the image tag.\n2. Rebuild the exact container image.\n',
          requestId: 'runbook-write',
        },
        'whatsapp_main',
        true,
        deps,
      );

      const response = JSON.parse(
        fs.readFileSync(
          path.join(
            DATA_DIR,
            'ipc',
            'whatsapp_main',
            'responses',
            'runbook-write.json',
          ),
          'utf-8',
        ),
      ) as { ok: boolean; kind?: string; relativePath?: string };

      expect(response).toMatchObject({
        ok: true,
        kind: 'skill_candidate',
      });
      expect(response.relativePath).toBe(
        path.join('skill-candidates', 'deploy-recovery.md'),
      );
      expect(
        fs.readFileSync(
          path.join(runbooksDir, 'skill-candidates', 'deploy-recovery.md'),
          'utf-8',
        ),
      ).toContain('# Deploy recovery');
      expect(
        fs.readFileSync(path.join(runbooksDir, 'index.md'), 'utf-8'),
      ).toContain('`skill-candidates/deploy-recovery.md`');
    } finally {
      fs.rmSync(runbooksDir, { recursive: true, force: true });
    }
  });

  it('reviews memory health and promotes a skill candidate into a runbook', async () => {
    const groupDir = path.join(process.cwd(), 'groups', 'whatsapp_main');
    const runbooksDir = path.join(groupDir, 'runbooks');

    try {
      await processTaskIpc(
        {
          type: 'manage_runbook',
          kind: 'skill_candidate',
          title: 'Incident triage',
          summary: 'Draft incident triage checklist.',
          content: '1. Confirm impact.\n2. Check rollback path.\n',
          requestId: 'candidate-write',
        },
        'whatsapp_main',
        true,
        deps,
      );

      fs.writeFileSync(
        path.join(groupDir, 'WORKING_MEMORY.md'),
        '# WORKING MEMORY\n\nRecent triage context.\n',
        'utf-8',
      );
      fs.utimesSync(
        path.join(groupDir, 'WORKING_MEMORY.md'),
        new Date('2026-03-01T00:00:00.000Z'),
        new Date('2026-03-01T00:00:00.000Z'),
      );

      await processTaskIpc(
        {
          type: 'review_memory',
          limit: 5,
          requestId: 'memory-review',
        },
        'whatsapp_main',
        true,
        deps,
      );

      const reviewResponse = JSON.parse(
        fs.readFileSync(
          path.join(
            DATA_DIR,
            'ipc',
            'whatsapp_main',
            'responses',
            'memory-review.json',
          ),
          'utf-8',
        ),
      ) as {
        ok: boolean;
        review?: {
          staleDocuments: Array<{ doc_type: string }>;
          skillCandidates: Array<{ relativePath?: string; doc_type: string }>;
          recentEvents: Array<{ event_type: string }>;
        };
      };

      expect(reviewResponse.ok).toBe(true);
      expect(
        reviewResponse.review?.staleDocuments.some(
          (doc) => doc.doc_type === 'working_memory',
        ),
      ).toBe(true);
      expect(
        reviewResponse.review?.skillCandidates.some(
          (doc) => doc.doc_type === 'skill_candidate',
        ),
      ).toBe(true);
      expect(
        reviewResponse.review?.recentEvents.map((event) => event.event_type),
      ).toContain('runbook_write');

      await processTaskIpc(
        {
          type: 'manage_runbook',
          action: 'promote',
          candidatePath: 'skill-candidates/incident-triage.md',
          title: 'Incident triage',
          summary: 'Approved incident triage checklist.',
          requestId: 'candidate-promote',
        },
        'whatsapp_main',
        true,
        deps,
      );

      const promoteResponse = JSON.parse(
        fs.readFileSync(
          path.join(
            DATA_DIR,
            'ipc',
            'whatsapp_main',
            'responses',
            'candidate-promote.json',
          ),
          'utf-8',
        ),
      ) as {
        ok: boolean;
        action?: string;
        relativePath?: string;
        sourceRelativePath?: string;
      };

      expect(promoteResponse).toMatchObject({
        ok: true,
        action: 'promote',
        relativePath: 'incident-triage.md',
        sourceRelativePath: 'skill-candidates/incident-triage.md',
      });
      expect(
        fs.existsSync(
          path.join(runbooksDir, 'skill-candidates', 'incident-triage.md'),
        ),
      ).toBe(false);
      expect(fs.existsSync(path.join(runbooksDir, 'incident-triage.md'))).toBe(
        true,
      );
    } finally {
      fs.rmSync(path.join(groupDir, 'WORKING_MEMORY.md'), { force: true });
      fs.rmSync(runbooksDir, { recursive: true, force: true });
    }
  });
});
