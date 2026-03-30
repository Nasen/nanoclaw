import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetAgentBackendConfig } = vi.hoisted(() => ({
  mockGetAgentBackendConfig: vi.fn(),
}));

vi.mock('./agent-backend.js', () => ({
  getAgentBackendConfig: mockGetAgentBackendConfig,
}));

import { _initTestDatabase, getSession, setSession } from './db.js';
import {
  buildChatTurnInput,
  handleReservedSlashCommand,
} from './slash-commands.js';

describe('slash-commands', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
    mockGetAgentBackendConfig.mockReturnValue({ backend: 'claude' });
  });

  it('treats a standalone slash command as raw input', () => {
    const turnInput = buildChatTurnInput(
      [
        {
          id: 'msg-1',
          chat_jid: 'group@g.us',
          sender: 'alice',
          sender_name: 'Alice',
          content: '/compact',
          timestamp: '2024-01-01T00:00:00.000Z',
        },
      ],
      'UTC',
    );

    expect(turnInput.mode).toBe('raw');
    expect(turnInput.text).toBe('/compact');
    expect(turnInput.slashCommand?.command).toBe('/compact');
  });

  it('host-handles /reset by clearing the stored session and closing the live chat container', async () => {
    setSession('group-folder', 'session-123');
    const queue = {
      resetChatSession: vi.fn(),
    };
    const sendMessage = vi.fn(async () => {});

    const handled = await handleReservedSlashCommand({
      slashCommand: {
        raw: '/reset',
        command: '/reset',
        args: '',
      },
      chatJid: 'group@g.us',
      groupFolder: 'group-folder',
      queue: queue as any,
      sendMessage,
    });

    expect(handled).toBe(true);
    expect(getSession('group-folder')).toBeUndefined();
    expect(queue.resetChatSession).toHaveBeenCalledWith('group@g.us');
    expect(sendMessage).toHaveBeenCalledWith(
      'Session reset. The next message starts a fresh session.',
    );
  });

  it('rejects /clear when the backend does not support native compaction commands', async () => {
    mockGetAgentBackendConfig.mockReturnValue({ backend: 'openai' });
    const sendMessage = vi.fn(async () => {});

    const handled = await handleReservedSlashCommand({
      slashCommand: {
        raw: '/clear',
        command: '/clear',
        args: '',
      },
      chatJid: 'group@g.us',
      groupFolder: 'group-folder',
      queue: {
        resetChatSession: vi.fn(),
      } as any,
      sendMessage,
    });

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      '/clear is not supported by the current openai backend.',
    );
  });
});
