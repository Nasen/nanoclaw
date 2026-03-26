import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getAllChats, storeChatMetadata } from '../db.js';
import { _listChatsPaginated, RingCentralChannel } from './ringcentral.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('_listChatsPaginated', () => {
  it('continues to later pages when searching by team name', async () => {
    const fetchPage = vi.fn<
      (
        pageToken: string | undefined,
        pageSize: number,
      ) => Promise<{
        records?: Array<{ id?: string; name?: string }>;
        navigation?: { nextPageToken?: string; prevPageToken?: string };
      }>
    >();

    fetchPage.mockImplementation(async (pageToken) => {
      if (!pageToken) {
        return {
          records: [{ id: '111', name: 'Some Other Team' }],
          navigation: { prevPageToken: 'page-2' },
        };
      }

      expect(pageToken).toBe('page-2');
      return {
        records: [{ id: '140855713798', name: 'Jupiter + NC CI Status' }],
      };
    });

    const chats = await _listChatsPaginated(fetchPage, {
      query: 'Jupiter + NC CI Status',
      limit: 20,
    });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(chats).toEqual([
      { id: '140855713798', name: 'Jupiter + NC CI Status' },
    ]);
  });

  it('explores both pagination directions so RC prevPageToken pages are searchable', async () => {
    const fetchPage = vi.fn<
      (
        pageToken: string | undefined,
        pageSize: number,
      ) => Promise<{
        records?: Array<{ id?: string; name?: string }>;
        navigation?: { nextPageToken?: string; prevPageToken?: string };
      }>
    >();

    fetchPage.mockImplementation(async (pageToken) => {
      if (!pageToken) {
        return {
          records: [{ id: '111', name: 'Some Other Team' }],
          navigation: {
            prevPageToken: 'page-prev',
            nextPageToken: 'page-next',
          },
        };
      }

      if (pageToken === 'page-prev') {
        return {
          records: [{ id: '140855713798', name: 'Jupiter + NC CI Status' }],
        };
      }

      return {
        records: [{ id: '333', name: 'Another Team' }],
      };
    });

    const chats = await _listChatsPaginated(fetchPage, {
      query: 'Jupiter + NC CI Status',
      limit: 20,
    });

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(chats).toEqual([
      { id: '140855713798', name: 'Jupiter + NC CI Status' },
    ]);
  });

  it('collects every page during metadata sync', async () => {
    const fetchPage = vi.fn<
      (
        pageToken: string | undefined,
        pageSize: number,
      ) => Promise<{
        records?: Array<{ id?: string; name?: string }>;
        navigation?: { nextPageToken?: string; prevPageToken?: string };
      }>
    >();

    fetchPage.mockImplementation(async (pageToken) => {
      if (!pageToken) {
        return {
          records: [{ id: '111', name: 'Team One' }],
          navigation: { nextPageToken: 'page-2' },
        };
      }

      expect(pageToken).toBe('page-2');
      return {
        records: [{ id: '222', name: 'Team Two' }],
      };
    });

    const chats = await _listChatsPaginated(fetchPage, {
      fetchAll: true,
    });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(chats).toEqual([
      { id: '111', name: 'Team One' },
      { id: '222', name: 'Team Two' },
    ]);
  });

  it('stops after the first page when no query is provided and the limit is satisfied', async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      records: [
        { id: '111', name: 'Team One' },
        { id: '222', name: 'Team Two' },
      ],
      navigation: { nextPageToken: 'page-2' },
    });

    const chats = await _listChatsPaginated(fetchPage, {
      limit: 1,
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(chats).toEqual([{ id: '111', name: 'Team One' }]);
  });

  it('stops after the matching page when a query is satisfied', async () => {
    const fetchPage = vi.fn<
      (
        pageToken: string | undefined,
        pageSize: number,
      ) => Promise<{
        records?: Array<{ id?: string; name?: string }>;
        navigation?: { nextPageToken?: string; prevPageToken?: string };
      }>
    >();

    fetchPage.mockImplementation(async (pageToken) => {
      if (!pageToken) {
        return {
          records: [{ id: '140855713798', name: 'Jupiter + NC CI Status' }],
          navigation: { nextPageToken: 'page-2' },
        };
      }

      return {
        records: [{ id: '222', name: 'Another Team' }],
      };
    });

    const chats = await _listChatsPaginated(fetchPage, {
      query: 'Jupiter + NC CI Status',
      limit: 1,
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(chats).toEqual([
      { id: '140855713798', name: 'Jupiter + NC CI Status' },
    ]);
  });
});

describe('RingCentralChannel.readMessagesForAgent', () => {
  it('resolves an uncached DM by directory lookup before reading messages', async () => {
    const channel = new RingCentralChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      creds: {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        jwt: 'test-jwt',
      },
    });

    const platform = {
      get: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats') {
          return {
            json: async () => ({
              records: [],
            }),
          };
        }

        if (path === '/team-messaging/v1/teams') {
          return {
            json: async () => ({
              records: [],
            }),
          };
        }

        if (path === '/restapi/v1.0/account/~/directory/entries') {
          return {
            json: async () => ({
              records: [
                {
                  id: '7001',
                  firstName: 'John',
                  lastName: 'Lin',
                  status: 'Enabled',
                  email: 'john.lin@ringcentral.com',
                },
              ],
              paging: {
                totalPages: 1,
              },
            }),
          };
        }

        if (path === '/team-messaging/v1/persons/7001') {
          return {
            json: async () => ({
              firstName: 'John',
              lastName: 'Lin',
            }),
          };
        }

        if (path === '/team-messaging/v1/chats/99001/posts') {
          return {
            json: async () => ({
              records: [
                {
                  id: 'post-1',
                  text: 'hello from John',
                  creatorId: '7001',
                  creationTime: '2026-03-26T00:00:00.000Z',
                },
              ],
            }),
          };
        }

        throw new Error(`Unexpected path: ${path}`);
      }),
      post: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/conversations') {
          return {
            json: async () => ({
              id: '99001',
              type: 'Direct',
              members: [{ id: '7001' }, { id: '860412020' }],
            }),
          };
        }

        throw new Error(`Unexpected path: ${path}`);
      }),
    };

    Object.assign(channel as object, {
      platform,
      botExtId: '860412020',
    });
    (
      channel as unknown as { refreshPlatform: () => Promise<unknown> }
    ).refreshPlatform = vi.fn(async () => platform);

    await expect(
      channel.readMessagesForAgent('John Lin', 5),
    ).resolves.toMatchObject({
      jid: 'rc:99001',
      chatId: '99001',
      name: 'John Lin',
      messages: [
        {
          id: 'post-1',
          text: 'hello from John',
        },
      ],
    });
  });

  it('hydrates opaque direct-chat names from the other member', async () => {
    storeChatMetadata('rc:14838513666', '2026-03-24T07:23:27.371Z');

    const channel = new RingCentralChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      creds: {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        jwt: 'test-jwt',
      },
    });

    const platform = {
      get: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats/14838513666') {
          return {
            json: async () => ({
              id: '14838513666',
              type: 'Direct',
              members: [{ id: '558463020' }, { id: '860412020' }],
            }),
          };
        }

        if (path === '/team-messaging/v1/persons/558463020') {
          return {
            json: async () => ({
              firstName: 'Ian',
              lastName: 'Zhang',
            }),
          };
        }

        if (path === '/team-messaging/v1/chats/14838513666/posts') {
          return {
            json: async () => ({
              records: [
                {
                  id: 'post-1',
                  text: 'latest message',
                  creatorId: '558463020',
                  creationTime: '2026-03-24T07:14:57.923Z',
                },
              ],
            }),
          };
        }

        throw new Error(`Unexpected path: ${path}`);
      }),
    };

    Object.assign(channel as object, {
      platform,
      botExtId: '860412020',
    });
    (
      channel as unknown as { refreshPlatform: () => Promise<unknown> }
    ).refreshPlatform = vi.fn(async () => platform);

    await expect(
      channel.readMessagesForAgent('14838513666', 5),
    ).resolves.toMatchObject({
      jid: 'rc:14838513666',
      chatId: '14838513666',
      name: 'Ian Zhang',
    });

    expect(getAllChats()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jid: 'rc:14838513666',
          name: 'Ian Zhang',
        }),
      ]),
    );
  });

  it('surfaces RC post fetch failures instead of returning an empty transcript', async () => {
    const channel = new RingCentralChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      creds: {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        jwt: 'test-jwt',
      },
    });

    const platform = {
      get: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats/140855713798') {
          return {
            json: async () => ({
              id: '140855713798',
              name: 'Jupiter + NC CI Status',
            }),
          };
        }

        if (path === '/team-messaging/v1/chats/140855713798/posts') {
          throw new Error('Request rate exceeded.');
        }

        throw new Error(`Unexpected path: ${path}`);
      }),
    };

    Object.assign(channel as object, { platform });
    (
      channel as unknown as { refreshPlatform: () => Promise<unknown> }
    ).refreshPlatform = vi.fn(async () => platform);

    await expect(
      channel.readMessagesForAgent('140855713798', 5),
    ).rejects.toThrow('Request rate exceeded.');
  });

  it('retries RC reads with a fresh platform when the long-lived client returns 404', async () => {
    const channel = new RingCentralChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      creds: {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        jwt: 'test-jwt',
      },
    });

    const stalePlatform = {
      get: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats/140855713798') {
          return {
            json: async () => ({
              id: '140855713798',
              name: 'Jupiter + NC CI Status',
            }),
          };
        }

        if (path === '/team-messaging/v1/chats/140855713798/posts') {
          throw new Error('404 Not Found');
        }

        throw new Error(`Unexpected path on stale platform: ${path}`);
      }),
    };

    const freshPlatform = {
      get: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats/140855713798') {
          return {
            json: async () => ({
              id: '140855713798',
              name: 'Jupiter + NC CI Status',
            }),
          };
        }

        if (path === '/team-messaging/v1/chats/140855713798/posts') {
          return {
            json: async () => ({
              records: [
                {
                  id: 'post-1',
                  text: 'latest message',
                  creatorId: '',
                  creationTime: '2026-03-26T00:51:08.727Z',
                },
              ],
            }),
          };
        }

        throw new Error(`Unexpected path on fresh platform: ${path}`);
      }),
    };

    Object.assign(channel as object, { platform: stalePlatform });
    (
      channel as unknown as { refreshPlatform: () => Promise<unknown> }
    ).refreshPlatform = vi.fn(async () => freshPlatform);

    await expect(
      channel.readMessagesForAgent('140855713798', 5),
    ).resolves.toMatchObject({
      jid: 'rc:140855713798',
      chatId: '140855713798',
      name: 'Jupiter + NC CI Status',
      messages: [
        {
          id: 'post-1',
          text: 'latest message',
        },
      ],
    });
  });
});

describe('RingCentralChannel sent post tracking', () => {
  it('treats posts sent by one RC channel as own posts on another RC channel', () => {
    const channelA = new RingCentralChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      creds: {
        clientId: 'test-client-a',
        clientSecret: 'test-secret-a',
        jwt: 'test-jwt-a',
      },
    });
    const channelB = new RingCentralChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      name: 'rc-bot',
      jidPrefix: 'rcb:',
      creds: {
        clientId: 'test-client-b',
        clientSecret: 'test-secret-b',
        botToken: 'test-bot-token-b',
      },
    });

    (channelA as unknown as { trackSent: (postId: string) => void }).trackSent(
      'post-123',
    );

    expect(
      (channelB as unknown as { isOwn: (postId: string) => boolean }).isOwn(
        'post-123',
      ),
    ).toBe(true);
  });

  it('uses the chats posts endpoint for bot-auth sends', async () => {
    const channel = new RingCentralChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      name: 'rc-bot',
      jidPrefix: 'rcb:',
      creds: {
        clientId: 'test-client-bot',
        clientSecret: 'test-secret-bot',
        botToken: 'test-bot-token',
      },
    });

    const platform = {
      post: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats/157530931206/posts') {
          return {
            json: async () => ({
              id: 'post-123',
            }),
          };
        }

        throw new Error(`Unexpected post path: ${path}`);
      }),
      get: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats/157530931206/posts') {
          return {
            json: async () => ({
              records: [
                {
                  id: 'post-123',
                  creatorId: '5104955020',
                  text: 'hello from bot',
                  creationTime: '2026-03-26T05:50:14.677Z',
                },
              ],
            }),
          };
        }

        throw new Error(`Unexpected get path: ${path}`);
      }),
    };

    Object.assign(channel as object, {
      connected: true,
      platform,
      botExtId: '5104955020',
    });
    (
      channel as unknown as {
        getSendPlatform: (chatId: string) => Promise<unknown>;
      }
    ).getSendPlatform = vi.fn(async () => ({
      platform,
      expectedCreatorId: '5104955020',
      ownerId: '5104955020',
    }));

    await channel.sendMessage('rcb:157530931206', 'hello from bot');

    expect(platform.post).toHaveBeenCalledWith(
      '/team-messaging/v1/chats/157530931206/posts',
      { text: 'hello from bot' },
    );
  });

  it('queues bot-auth sends when verification resolves to a personal creator', async () => {
    const channel = new RingCentralChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      name: 'rc-bot',
      jidPrefix: 'rcb:',
      creds: {
        clientId: 'test-client-bot',
        clientSecret: 'test-secret-bot',
        botToken: 'test-bot-token',
      },
    });

    const platform = {
      post: vi.fn(async () => ({
        json: async () => ({
          id: 'post-123',
        }),
      })),
      get: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats/157530931206/posts') {
          return {
            json: async () => ({
              records: [
                {
                  id: 'post-123',
                  creatorId: '860412020',
                  text: 'hello from personal',
                  creationTime: '2026-03-26T05:50:14.677Z',
                },
              ],
            }),
          };
        }

        throw new Error(`Unexpected get path: ${path}`);
      }),
    };

    (
      channel as unknown as {
        getSendPlatform: (chatId: string) => Promise<unknown>;
      }
    ).getSendPlatform = vi.fn(async () => ({
      platform,
      expectedCreatorId: '5104955020',
      ownerId: '5104955020',
    }));

    Object.assign(channel as object, {
      connected: true,
      platform,
      botExtId: '5104955020',
    });

    await channel.sendMessage('rcb:157530931206', 'hello from bot');

    expect(platform.post).toHaveBeenCalledWith(
      '/team-messaging/v1/chats/157530931206/posts',
      { text: 'hello from bot' },
    );
    expect(
      (
        channel as unknown as {
          outgoingQueue: Array<{ jid: string; text: string }>;
        }
      ).outgoingQueue,
    ).toEqual([{ jid: 'rcb:157530931206', text: 'hello from bot' }]);
  });
});

describe('RingCentralChannel.handleEvent', () => {
  it('ignores unknown auto-register chats without posting a rejection reply', async () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();

    const channel = new RingCentralChannel({
      onMessage,
      onChatMetadata,
      registeredGroups: () => ({}),
      name: 'rc-bot',
      jidPrefix: 'rcb:',
      autoRegister: true,
      creds: {
        clientId: 'test-client-bot',
        clientSecret: 'test-secret-bot',
        botToken: 'test-bot-token',
      },
    });

    Object.assign(channel as object, {
      botExtId: '5104955020',
    });

    const sendMessage = vi.fn();
    Object.assign(channel as object, { sendMessage });
    (
      channel as unknown as {
        handleEvent: (event: unknown) => Promise<void>;
      }
    ).handleEvent({
      body: {
        eventType: 'PostAdded',
        id: 'post-1',
        groupId: '157530931206',
        creatorId: '860412020',
        creationTime: '2026-03-26T06:00:00.000Z',
        text: 'hello team',
      },
    });

    await Promise.resolve();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onChatMetadata).toHaveBeenCalledWith(
      'rcb:157530931206',
      '2026-03-26T06:00:00.000Z',
      undefined,
      'rc-bot',
      true,
    );
  });

  it('captures ownerId from inbound RC events', async () => {
    const channel = new RingCentralChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({
        'rcb:157530931206': {
          name: 'NanoClaw-Personal',
          folder: 'rc-personal',
          trigger: '@Bob',
          added_at: '2026-03-26T00:00:00.000Z',
          requiresTrigger: false,
          isMain: true,
        },
      }),
      name: 'rc-bot',
      jidPrefix: 'rcb:',
      autoRegister: true,
      creds: {
        clientId: 'test-client-bot',
        clientSecret: 'test-secret-bot',
        botToken: 'test-bot-token',
      },
    });

    Object.assign(channel as object, {
      botExtId: '5104955020',
    });

    await (
      channel as unknown as {
        handleEvent: (event: unknown) => Promise<void>;
      }
    ).handleEvent({
      ownerId: '5104955020',
      body: {
        eventType: 'PostAdded',
        id: 'post-1',
        groupId: '157530931206',
        creatorId: '860412020',
        creationTime: '2026-03-26T06:00:00.000Z',
        text: 'hello team',
      },
    });

    expect(
      (
        channel as unknown as {
          lastOwnerIdByChat: Map<string, string>;
        }
      ).lastOwnerIdByChat.get('157530931206'),
    ).toBe('5104955020');
  });
});

describe('RingCentralChannel.listChatsForAgent', () => {
  it('resolves a numeric direct-chat id without scanning RC chat search', async () => {
    storeChatMetadata('rc:14711291906', '2026-03-12T09:37:20.310Z');

    const channel = new RingCentralChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      creds: {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        jwt: 'test-jwt',
      },
    });

    const platform = {
      get: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats/14711291906') {
          return {
            json: async () => ({
              id: '14711291906',
              type: 'Direct',
              members: [{ id: '608081020' }, { id: '860412020' }],
            }),
          };
        }

        if (path === '/team-messaging/v1/persons/608081020') {
          return {
            json: async () => ({
              firstName: 'John',
              lastName: 'Lin',
            }),
          };
        }

        throw new Error(`Unexpected path: ${path}`);
      }),
    };

    Object.assign(channel as object, {
      platform,
      botExtId: '860412020',
    });

    await expect(channel.listChatsForAgent('14711291906', 5)).resolves.toEqual([
      {
        jid: 'rc:14711291906',
        chatId: '14711291906',
        name: 'John Lin',
      },
    ]);
  });

  it('resolves an uncached DM by directory lookup', async () => {
    const channel = new RingCentralChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      creds: {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        jwt: 'test-jwt',
      },
    });

    const platform = {
      get: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats') {
          return {
            json: async () => ({
              records: [],
            }),
          };
        }

        if (path === '/team-messaging/v1/teams') {
          return {
            json: async () => ({
              records: [],
            }),
          };
        }

        if (path === '/restapi/v1.0/account/~/directory/entries') {
          return {
            json: async () => ({
              records: [
                {
                  id: '7001',
                  firstName: 'John',
                  lastName: 'Lin',
                  status: 'Enabled',
                  email: 'john.lin@ringcentral.com',
                },
              ],
              paging: {
                totalPages: 1,
              },
            }),
          };
        }

        if (path === '/team-messaging/v1/persons/7001') {
          return {
            json: async () => ({
              firstName: 'John',
              lastName: 'Lin',
            }),
          };
        }

        throw new Error(`Unexpected path: ${path}`);
      }),
      post: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/conversations') {
          return {
            json: async () => ({
              id: '99001',
              type: 'Direct',
              members: [{ id: '7001' }, { id: '860412020' }],
            }),
          };
        }

        throw new Error(`Unexpected path: ${path}`);
      }),
    };

    Object.assign(channel as object, {
      platform,
      botExtId: '860412020',
    });

    await expect(channel.listChatsForAgent('John Lin', 5)).resolves.toEqual([
      {
        jid: 'rc:99001',
        chatId: '99001',
        name: 'John Lin',
      },
    ]);

    expect(getAllChats()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jid: 'rc:99001',
          name: 'John Lin',
        }),
      ]),
    );
  });

  it('finds opaque cached direct chats by hydrated member name', async () => {
    storeChatMetadata('rc:14838513666', '2026-03-24T07:23:27.371Z');

    const channel = new RingCentralChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      creds: {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        jwt: 'test-jwt',
      },
    });

    const platform = {
      get: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats') {
          return {
            json: async () => ({
              records: [],
            }),
          };
        }

        if (path === '/team-messaging/v1/teams') {
          return {
            json: async () => ({
              records: [],
            }),
          };
        }

        if (path === '/team-messaging/v1/chats/14838513666') {
          return {
            json: async () => ({
              id: '14838513666',
              type: 'Direct',
              members: [{ id: '558463020' }, { id: '860412020' }],
            }),
          };
        }

        if (path === '/team-messaging/v1/persons/558463020') {
          return {
            json: async () => ({
              firstName: 'Ian',
              lastName: 'Zhang',
            }),
          };
        }

        throw new Error(`Unexpected path: ${path}`);
      }),
    };

    Object.assign(channel as object, {
      platform,
      botExtId: '860412020',
    });

    await expect(channel.listChatsForAgent('Ian Zhang', 5)).resolves.toEqual([
      {
        jid: 'rc:14838513666',
        chatId: '14838513666',
        name: 'Ian Zhang',
      },
    ]);

    expect(getAllChats()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jid: 'rc:14838513666',
          name: 'Ian Zhang',
        }),
      ]),
    );
  });
});
