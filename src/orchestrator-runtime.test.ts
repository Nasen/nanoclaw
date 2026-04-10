import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RingCentralChannel } from './channels/ringcentral.js';
import {
  _resetRcCooldownsForTests,
  listRcChats,
  readRcMessages,
} from './orchestrator-runtime.js';

function createRcChannel(name: 'rc' | 'rc-bot'): RingCentralChannel {
  const channel = new RingCentralChannel({
    name,
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    creds: {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      jwt: 'test-jwt',
    },
  });

  Object.assign(channel as object, { connected: true });
  return channel;
}

beforeEach(() => {
  _resetRcCooldownsForTests();
});

describe('orchestrator RC fallback', () => {
  it('reuses the alternate RC channel while the primary mode is cooling down', async () => {
    const personal = createRcChannel('rc');
    const bot = createRcChannel('rc-bot');

    const personalListChats = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('Request rate exceeded'), {
        retryAfter: 60000,
      }),
    );
    const botListChats = vi.fn().mockResolvedValue([
      {
        jid: 'rcb:123',
        chatId: '123',
        name: 'Cao Ke',
      },
    ]);

    Object.assign(personal as object, {
      listChatsForAgent: personalListChats,
    });
    Object.assign(bot as object, {
      listChatsForAgent: botListChats,
    });

    await expect(
      listRcChats([personal, bot], 'personal', 'Cao', 5),
    ).resolves.toEqual([
      {
        jid: 'rcb:123',
        chatId: '123',
        name: 'Cao Ke',
      },
    ]);

    await expect(
      listRcChats([personal, bot], 'personal', 'Cao', 5),
    ).resolves.toEqual([
      {
        jid: 'rcb:123',
        chatId: '123',
        name: 'Cao Ke',
      },
    ]);

    expect(personalListChats).toHaveBeenCalledTimes(1);
    expect(botListChats).toHaveBeenCalledTimes(2);
  });

  it('fails fast when both RC modes are cooling down', async () => {
    const personal = createRcChannel('rc');
    const bot = createRcChannel('rc-bot');

    const personalReadMessages = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('Request rate exceeded'), {
        retryAfter: 60000,
      }),
    );
    const botReadMessages = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('Request rate exceeded'), {
        retryAfter: 60000,
      }),
    );

    Object.assign(personal as object, {
      readMessagesForAgent: personalReadMessages,
    });
    Object.assign(bot as object, {
      readMessagesForAgent: botReadMessages,
    });

    await expect(
      readRcMessages([personal, bot], 'Cao Ke', 'personal', 5),
    ).rejects.toThrow('Request rate exceeded');

    await expect(
      readRcMessages([personal, bot], 'Cao Ke', 'personal', 5),
    ).rejects.toThrow('RingCentral');

    expect(personalReadMessages).toHaveBeenCalledTimes(1);
    expect(botReadMessages).toHaveBeenCalledTimes(1);
  });
});
