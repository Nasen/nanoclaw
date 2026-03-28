import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  consumePendingMessages,
  recoverPendingMessages,
  shouldPipeMessagesToActiveContainer,
} from './message-loop.js';
import { _initTestDatabase, storeChatMetadata, storeMessage } from './db.js';
import {
  _resetServiceStateForTests,
  setRuntimeServiceEnabled,
} from './service-state.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(folder: string): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '@NanoClaw',
    added_at: new Date().toISOString(),
  };
}

describe('shouldPipeMessagesToActiveContainer', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetServiceStateForTests();
  });

  it('disables active-container piping for rc-personal', () => {
    expect(shouldPipeMessagesToActiveContainer(makeGroup('rc-personal'))).toBe(
      false,
    );
  });

  it('keeps active-container piping for other groups', () => {
    expect(
      shouldPipeMessagesToActiveContainer(makeGroup('rc-grp-builds')),
    ).toBe(true);
  });

  it('consumes pending messages without enqueueing them', () => {
    const saveState = vi.fn();
    const timestamps: Record<string, string> = {};

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    consumePendingMessages(
      { 'group@g.us': makeGroup('group') },
      (chatJid) => timestamps[chatJid] || '',
      (chatJid, timestamp) => {
        timestamps[chatJid] = timestamp;
      },
      saveState,
    );

    expect(timestamps['group@g.us']).toBe('2024-01-01T00:00:01.000Z');
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it('skips pending message recovery while the service is disabled', () => {
    const enqueueMessageCheck = vi.fn();

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    setRuntimeServiceEnabled(false);
    recoverPendingMessages({ 'group@g.us': makeGroup('group') }, () => '', {
      enqueueMessageCheck,
    } as any);

    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });
});
