import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunContainerAgent, mockWriteTasksSnapshot } = vi.hoisted(() => ({
  mockRunContainerAgent: vi.fn(),
  mockWriteTasksSnapshot: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: mockRunContainerAgent,
  writeTasksSnapshot: mockWriteTasksSnapshot,
}));

import { _initTestDatabase, createTask, setRegisteredGroup } from './db.js';
import { runScheduledTask } from './task-execution.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';

function makeTask(): ScheduledTask {
  return {
    id: 'task-1',
    group_folder: 'rc-grp-nanoclaw-jiraops',
    chat_jid: 'rcb:158813085702',
    prompt: 'sync latest changes',
    schedule_type: 'once',
    schedule_value: '2026-03-30T12:00:00.000Z',
    context_mode: 'isolated',
    next_run: '2026-03-30T12:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-03-30T00:00:00.000Z',
  };
}

describe('runScheduledTask', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('treats configured main folders as main for scheduled tasks', async () => {
    const group: RegisteredGroup = {
      name: 'RC Team',
      folder: 'rc-grp-nanoclaw-jiraops',
      trigger: '@Bob',
      added_at: '2026-03-30T00:00:00.000Z',
    };
    const task = makeTask();

    setRegisteredGroup(task.chat_jid, group);
    createTask(task);
    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    await runScheduledTask(task, {
      registeredGroups: () => ({ [task.chat_jid]: group }),
      queue: {
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: vi.fn(),
      sendMessage: vi.fn(async () => {}),
    });

    expect(mockWriteTasksSnapshot).toHaveBeenCalledWith(
      task.group_folder,
      true,
      expect.any(Array),
    );
    expect(mockRunContainerAgent).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain: true,
        isScheduledTask: true,
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });
});
