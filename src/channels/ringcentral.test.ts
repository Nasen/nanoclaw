import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getAllChats,
  storeChatMetadata,
  storeMessage,
} from '../db.js';
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
  it('resolves an existing opaque DM by directory-backed lookup before reading messages', async () => {
    storeChatMetadata('rc:99001', '2026-03-26T00:00:00.000Z');

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

        if (path === '/team-messaging/v1/chats/99001') {
          return {
            json: async () => ({
              id: '99001',
              type: 'Direct',
              members: [{ id: '7001' }, { id: '860412020' }],
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
    };

    Object.assign(channel as object, {
      platform,
      botExtId: '860412020',
    });
    (
      channel as unknown as { refreshPlatform: () => Promise<unknown> }
    ).refreshPlatform = vi.fn(async () => platform);

    await expect(
      channel.readMessagesForAgent('john.lin@ringcentral.com', 5),
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

  it('resolves a DM from local message history before RC chat search when reading messages', async () => {
    storeChatMetadata('rc:77123', '2026-03-20T02:01:24.651Z');
    storeChatMetadata(
      'rcb:139807227910',
      '2026-03-20T02:01:24.651Z',
      'Jupiter-NC Automation Blade',
      'rc',
      true,
    );
    storeMessage({
      id: 'jia-read-1',
      chat_jid: 'rcb:139807227910',
      sender: '4189132020',
      sender_name: 'Jia Zhang',
      content: 'hello from Jia',
      timestamp: '2026-03-20T02:01:24.651Z',
    });

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
        if (path === '/team-messaging/v1/chats/77123') {
          return {
            json: async () => ({
              id: '77123',
              type: 'Direct',
              members: [{ id: '4189132020' }, { id: '860412020' }],
            }),
          };
        }

        if (path === '/team-messaging/v1/persons/4189132020') {
          return {
            json: async () => ({
              firstName: 'Jia',
              lastName: 'Zhang',
            }),
          };
        }

        if (path === '/team-messaging/v1/chats/77123/posts') {
          return {
            json: async () => ({
              records: [
                {
                  id: 'post-jia-1',
                  text: 'hello from Jia',
                  creatorId: '4189132020',
                  creationTime: '2026-03-20T02:01:24.651Z',
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
      channel.readMessagesForAgent('Jia Zhang', 5),
    ).resolves.toMatchObject({
      jid: 'rc:77123',
      chatId: '77123',
      name: 'Jia Zhang',
      messages: [
        {
          id: 'post-jia-1',
          text: 'hello from Jia',
          creatorName: 'Jia Zhang',
        },
      ],
    });

    expect(platform.get).not.toHaveBeenCalledWith(
      '/team-messaging/v1/chats',
      expect.anything(),
    );
    expect(platform.get).not.toHaveBeenCalledWith(
      '/restapi/v1.0/account/~/directory/entries',
      expect.anything(),
    );
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

describe('RingCentralChannel.sendMessageForAgent', () => {
  it('resolves a cached DM name before sending a personal-authored RC message', async () => {
    storeChatMetadata('rc:14711291906', '2026-03-05T03:30:41.621Z', 'John Lin');

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
      post: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats/14711291906/posts') {
          return {
            json: async () => ({
              id: 'post-123',
            }),
          };
        }

        throw new Error(`Unexpected post path: ${path}`);
      }),
      get: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats/14711291906/posts') {
          return {
            json: async () => ({
              records: [
                {
                  id: 'post-123',
                  creatorId: '860412020',
                  text: 'hi',
                  creationTime: '2026-03-27T05:50:14.677Z',
                },
              ],
            }),
          };
        }

        throw new Error(`Unexpected get path: ${path}`);
      }),
    };

    Object.assign(channel as object, {
      platform,
      botExtId: '860412020',
    });

    await expect(
      channel.sendMessageForAgent('John Lin', 'hi'),
    ).resolves.toMatchObject({
      jid: 'rc:14711291906',
      chatId: '14711291906',
      postId: 'post-123',
    });

    expect(platform.post).toHaveBeenCalledWith(
      '/team-messaging/v1/chats/14711291906/posts',
      { text: 'hi' },
    );
  });

  it('retries person-name sends with a live directory-backed conversation when a stale cached DM 404s', async () => {
    storeChatMetadata('rc:14711291906', '2026-03-05T03:30:41.621Z', 'John Lin');

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
      post: vi.fn(async (path: string, body?: unknown) => {
        if (path === '/team-messaging/v1/chats/14711291906/posts') {
          throw new Error('404 Not Found');
        }

        if (path === '/team-messaging/v1/conversations') {
          expect(body).toEqual({
            members: [{ id: '608081020' }],
          });
          return {
            json: async () => ({
              id: '22222',
              type: 'Direct',
              members: [{ id: '608081020' }, { id: '860412020' }],
            }),
          };
        }

        if (path === '/team-messaging/v1/chats/22222/posts') {
          return {
            json: async () => ({
              id: 'post-456',
            }),
          };
        }

        throw new Error(`Unexpected post path: ${path}`);
      }),
      get: vi.fn(async (path: string) => {
        if (path === '/restapi/v1.0/account/~/directory/entries') {
          return {
            json: async () => ({
              records: [
                {
                  id: '608081020',
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

        if (path === '/team-messaging/v1/persons/608081020') {
          return {
            json: async () => ({
              firstName: 'John',
              lastName: 'Lin',
            }),
          };
        }

        if (path === '/team-messaging/v1/chats/22222/posts') {
          return {
            json: async () => ({
              records: [
                {
                  id: 'post-456',
                  creatorId: '860412020',
                  text: 'hi',
                  creationTime: '2026-03-27T05:50:14.677Z',
                },
              ],
            }),
          };
        }

        throw new Error(`Unexpected get path: ${path}`);
      }),
    };

    Object.assign(channel as object, {
      platform,
      botExtId: '860412020',
    });

    await expect(
      channel.sendMessageForAgent('John Lin', 'hi'),
    ).resolves.toMatchObject({
      jid: 'rc:22222',
      chatId: '22222',
      postId: 'post-456',
    });

    expect(platform.post).toHaveBeenCalledWith(
      '/team-messaging/v1/chats/14711291906/posts',
      { text: 'hi' },
    );
    expect(platform.post).toHaveBeenCalledWith(
      '/team-messaging/v1/chats/22222/posts',
      { text: 'hi' },
    );
  });

  it('sends a DM directly from a person mention/id without chat lookup', async () => {
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
      post: vi.fn(async (path: string, body?: unknown) => {
        if (path === '/team-messaging/v1/conversations') {
          expect(body).toEqual({
            members: [{ id: '608081020' }],
          });
          return {
            json: async () => ({
              id: '33333',
              type: 'Direct',
              members: [{ id: '608081020' }, { id: '860412020' }],
            }),
          };
        }

        if (path === '/team-messaging/v1/chats/33333/posts') {
          return {
            json: async () => ({
              id: 'post-789',
            }),
          };
        }

        throw new Error(`Unexpected post path: ${path}`);
      }),
      get: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats/33333/posts') {
          return {
            json: async () => ({
              records: [
                {
                  id: 'post-789',
                  creatorId: '860412020',
                  text: 'hi',
                  creationTime: '2026-03-27T05:50:14.677Z',
                },
              ],
            }),
          };
        }

        throw new Error(`Unexpected get path: ${path}`);
      }),
    };

    Object.assign(channel as object, {
      platform,
      botExtId: '860412020',
    });

    await expect(
      channel.sendMessageForAgent('![:Person](608081020)', 'hi'),
    ).resolves.toMatchObject({
      jid: 'rc:33333',
      chatId: '33333',
      postId: 'post-789',
    });

    expect(platform.post).toHaveBeenCalledWith(
      '/team-messaging/v1/conversations',
      { members: [{ id: '608081020' }] },
    );
    expect(platform.post).toHaveBeenCalledWith(
      '/team-messaging/v1/chats/33333/posts',
      { text: 'hi' },
    );
  });

  it('sends to a team mention without trying to create a DM conversation', async () => {
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
      post: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats/158812848134/posts') {
          return {
            json: async () => ({
              id: 'post-team-123',
            }),
          };
        }

        throw new Error(`Unexpected post path: ${path}`);
      }),
      get: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats/158812848134') {
          return {
            json: async () => ({
              id: '158812848134',
              name: 'NanoClaw-GitOps',
              type: 'Team',
            }),
          };
        }

        if (path === '/team-messaging/v1/chats/158812848134/posts') {
          return {
            json: async () => ({
              records: [
                {
                  id: 'post-team-123',
                  creatorId: '860412020',
                  text: 'hi',
                  creationTime: '2026-03-31T06:00:00.000Z',
                },
              ],
            }),
          };
        }

        throw new Error(`Unexpected get path: ${path}`);
      }),
    };

    Object.assign(channel as object, {
      platform,
      botExtId: '860412020',
    });

    await expect(
      channel.sendMessageForAgent('![:Team](158812848134)', 'hi'),
    ).resolves.toMatchObject({
      jid: 'rc:158812848134',
      chatId: '158812848134',
      postId: 'post-team-123',
    });

    expect(platform.post).not.toHaveBeenCalledWith(
      '/team-messaging/v1/conversations',
      expect.anything(),
    );
    expect(platform.post).toHaveBeenCalledWith(
      '/team-messaging/v1/chats/158812848134/posts',
      { text: 'hi' },
    );
  });

  it('chunks oversized agent sends across multiple RC posts', async () => {
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

    let postCount = 0;
    const platform = {
      post: vi.fn(async (path: string, body?: { text?: string }) => {
        if (path === '/team-messaging/v1/chats/158812848134/posts') {
          postCount += 1;
          return {
            json: async () => ({
              id: `post-team-${postCount}`,
            }),
          };
        }

        throw new Error(`Unexpected post path: ${path}`);
      }),
      get: vi.fn(async (path: string) => {
        if (path === '/team-messaging/v1/chats/158812848134') {
          return {
            json: async () => ({
              id: '158812848134',
              name: 'NanoClaw-GitOps',
              type: 'Team',
            }),
          };
        }

        if (path === '/team-messaging/v1/chats/158812848134/posts') {
          return {
            json: async () => ({
              records: [
                {
                  id: 'post-team-2',
                  creatorId: '860412020',
                  text: 'tail',
                  creationTime: '2026-03-31T06:00:00.000Z',
                },
              ],
            }),
          };
        }

        throw new Error(`Unexpected get path: ${path}`);
      }),
    };

    Object.assign(channel as object, {
      platform,
      botExtId: '860412020',
    });

    const longText = 'x'.repeat(4500);
    await expect(
      channel.sendMessageForAgent('![:Team](158812848134)', longText),
    ).resolves.toMatchObject({
      jid: 'rc:158812848134',
      chatId: '158812848134',
      postId: 'post-team-2',
    });

    expect(platform.post).toHaveBeenNthCalledWith(
      1,
      '/team-messaging/v1/chats/158812848134/posts',
      { text: 'x'.repeat(4000) },
    );
    expect(platform.post).toHaveBeenNthCalledWith(
      2,
      '/team-messaging/v1/chats/158812848134/posts',
      { text: 'x'.repeat(500) },
    );
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

  it('ignores registered RC bot DMs outside rc-personal', async () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const channel = new RingCentralChannel({
      onMessage,
      onChatMetadata,
      registeredGroups: () => ({
        'rcb:1596659367938': {
          name: 'John Lin',
          folder: 'rc-john-lin',
          trigger: '@Bob',
          added_at: '2026-03-26T00:00:00.000Z',
          requiresTrigger: false,
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
      body: {
        eventType: 'PostAdded',
        id: 'post-direct-1',
        groupId: '1596659367938',
        creatorId: '608081020',
        creationTime: '2026-03-26T06:10:00.000Z',
        text: 'hello from john',
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onChatMetadata).toHaveBeenCalledWith(
      'rcb:1596659367938',
      '2026-03-26T06:10:00.000Z',
      undefined,
      'rc-bot',
      true,
    );
  });

  it('routes owner-only service commands from rc-personal to the control callback', async () => {
    const onOwnerCommand = vi.fn(async () => {});
    const channel = new RingCentralChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      onOwnerCommand,
      registeredGroups: () => ({
        'rc:157530931206': {
          name: 'NanoClaw-Personal',
          folder: 'rc-personal',
          trigger: '@Bob',
          added_at: '2026-03-26T00:00:00.000Z',
          requiresTrigger: false,
          isMain: true,
        },
      }),
      name: 'rc',
      jidPrefix: 'rc:',
      creds: {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        jwt: 'test-jwt',
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
      body: {
        eventType: 'PostAdded',
        id: 'post-2',
        groupId: '157530931206',
        creatorId: '5104955020',
        creationTime: '2026-03-26T06:05:00.000Z',
        text: 'disable service',
      },
    });

    expect(onOwnerCommand).toHaveBeenCalledWith({
      action: 'set_service_enabled',
      chatJid: 'rc:157530931206',
      value: false,
    });
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

  it('resolves an existing opaque DM by directory lookup', async () => {
    storeChatMetadata('rc:99001', '2026-03-26T00:00:00.000Z');

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

        if (path === '/team-messaging/v1/chats/99001') {
          return {
            json: async () => ({
              id: '99001',
              type: 'Direct',
              members: [{ id: '7001' }, { id: '860412020' }],
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
    };

    Object.assign(channel as object, {
      platform,
      botExtId: '860412020',
    });

    await expect(
      channel.listChatsForAgent('john.lin@ringcentral.com', 5),
    ).resolves.toEqual([
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

  it('resolves a DM from local message history before directory lookup', async () => {
    storeChatMetadata('rc:77123', '2026-03-20T02:01:24.651Z');
    storeChatMetadata(
      'rcb:139807227910',
      '2026-03-20T02:01:24.651Z',
      'Jupiter-NC Automation Blade',
      'rc',
      true,
    );
    storeMessage({
      id: 'jia-1',
      chat_jid: 'rcb:139807227910',
      sender: '4189132020',
      sender_name: 'Jia Zhang',
      content: 'hello from Jia',
      timestamp: '2026-03-20T02:01:24.651Z',
    });

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

        if (path === '/team-messaging/v1/chats/77123') {
          return {
            json: async () => ({
              id: '77123',
              type: 'Direct',
              members: [{ id: '4189132020' }, { id: '860412020' }],
            }),
          };
        }

        if (path === '/team-messaging/v1/persons/4189132020') {
          return {
            json: async () => ({
              firstName: 'Jia',
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

    await expect(channel.listChatsForAgent('Jia Zhang', 5)).resolves.toEqual([
      {
        jid: 'rc:77123',
        chatId: '77123',
        name: 'Jia Zhang',
      },
    ]);

    expect(platform.get).not.toHaveBeenCalledWith(
      '/restapi/v1.0/account/~/directory/entries',
      expect.anything(),
    );
  });
});
