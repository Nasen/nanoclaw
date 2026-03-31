import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRunContainerAgent,
  mockWriteGroupsSnapshot,
  mockWriteTasksSnapshot,
} = vi.hoisted(() => ({
  mockRunContainerAgent: vi.fn(),
  mockWriteGroupsSnapshot: vi.fn(),
  mockWriteTasksSnapshot: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: mockRunContainerAgent,
}));

vi.mock('./container-snapshots.js', () => ({
  writeGroupsSnapshot: mockWriteGroupsSnapshot,
  writeTasksSnapshot: mockWriteTasksSnapshot,
}));

import { _initTestDatabase, getSession, setSession } from './db.js';
import {
  runGroupAgent,
  shouldCloseContainerAfterTurn,
} from './group-agent-runner.js';
import type { ContainerOutput } from './container-contract.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(folder: string): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '@NanoClaw',
    added_at: new Date().toISOString(),
  };
}

describe('shouldCloseContainerAfterTurn', () => {
  it('does not auto-close rc-personal after the trailing success marker', () => {
    const result: ContainerOutput = {
      status: 'success',
      result: null,
    };

    expect(
      shouldCloseContainerAfterTurn(makeGroup('rc-personal'), result),
    ).toBe(false);
  });

  it('does not auto-close normal groups after the trailing success marker', () => {
    const result: ContainerOutput = {
      status: 'success',
      result: null,
    };

    expect(
      shouldCloseContainerAfterTurn(makeGroup('rc-grp-builds'), result),
    ).toBe(false);
  });
});

describe('runGroupAgent session persistence', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('passes the stored session ID into the container and persists the new one', async () => {
    setSession('group-folder', 'session-old');
    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
      newSessionId: 'session-new',
    });

    const deps = {
      queue: {
        registerProcess: vi.fn(),
      },
      getAvailableGroups: () => [],
      getRegisteredJids: () => new Set<string>(),
    };

    const result = await runGroupAgent(
      makeGroup('group-folder'),
      'hello',
      'group@g.us',
      deps as any,
    );

    expect(result).toBe('success');
    expect(mockRunContainerAgent).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        prompt: 'hello',
        groupFolder: 'group-folder',
        chatJid: 'group@g.us',
        sessionId: 'session-old',
      }),
      expect.any(Function),
      undefined,
    );
    expect(getSession('group-folder')).toBe('session-new');
  });
});
