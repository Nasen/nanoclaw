import { SDK } from '@ringcentral/sdk';
import { Subscriptions } from '@ringcentral/subscriptions';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile, readEnvFileByPrefix } from '../env.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelRegistration,
  ChannelSetup,
  ConversationInfo,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

type RCSdk = InstanceType<typeof SDK>;
type RCPlatform = ReturnType<RCSdk['platform']>;
type RcWsSubscription = {
  revoke?: () => Promise<void>;
  remove?: () => void;
  wse?: {
    disconnect?: () => Promise<void>;
  };
};

const DEFAULT_SERVER = 'https://platform.ringcentral.com';
const TM_BASE = '/team-messaging/v1';
const MAX_CHUNK = 4000;
const SENT_TTL_MS = 60_000;

interface RCCredentials {
  clientId: string;
  clientSecret: string;
  jwt?: string;
  botToken?: string;
  botTokensByOwnerId?: Record<string, string>;
  server: string;
}

interface RcChatListItem {
  id?: string;
  name?: string;
  type?: string;
}

interface RcPostBody {
  id?: string;
  text?: string;
  groupId?: string;
  creatorId?: string;
  creationTime?: string;
  eventType?: string;
  ownerId?: string | number;
}

function extractOwnerScopedBotTokens(values: Record<string, string>): Record<string, string> | undefined {
  const entries = Object.entries(values).map(([key, value]) => [key.slice('RC_BOT_TOKEN_OWNER_'.length), value]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function loadCredentials(mode: 'owner' | 'bot'): RCCredentials | null {
  const env = readEnvFile([
    'RC_CLIENT_ID',
    'RC_CLIENT_SECRET',
    'RC_JWT',
    'RC_BOT_CLIENT_ID',
    'RC_BOT_CLIENT_SECRET',
    'RC_BOT_TOKEN',
    'RC_SERVER',
  ]);

  if (mode === 'owner') {
    if (!env.RC_CLIENT_ID || !env.RC_CLIENT_SECRET || !env.RC_JWT) return null;
    return {
      clientId: env.RC_CLIENT_ID,
      clientSecret: env.RC_CLIENT_SECRET,
      jwt: env.RC_JWT,
      server: env.RC_SERVER || DEFAULT_SERVER,
    };
  }

  const clientId = env.RC_BOT_CLIENT_ID || env.RC_CLIENT_ID;
  const clientSecret = env.RC_BOT_CLIENT_SECRET || env.RC_CLIENT_SECRET;
  if (!clientId || !clientSecret || !env.RC_BOT_TOKEN) return null;
  return {
    clientId,
    clientSecret,
    botToken: env.RC_BOT_TOKEN,
    botTokensByOwnerId: extractOwnerScopedBotTokens(readEnvFileByPrefix('RC_BOT_TOKEN_OWNER_')),
    server: env.RC_SERVER || DEFAULT_SERVER,
  };
}

async function createAuthenticatedSdk(creds: RCCredentials): Promise<{ sdk: RCSdk; platform: RCPlatform }> {
  const sdk = new SDK({
    server: creds.server,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  });
  const platform = sdk.platform();

  if (creds.botToken) {
    await platform.auth().setData({
      access_token: creds.botToken,
      token_type: 'Bearer',
      expires_in: String(3600 * 24 * 365),
    });
  } else if (creds.jwt) {
    const authString = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    const postData = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: creds.jwt,
    }).toString();

    const resp = await fetch(`${creds.server}/restapi/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${authString}`,
      },
      body: postData,
    });
    if (!resp.ok) {
      throw new Error(`RingCentral JWT login failed (${resp.status}): ${await resp.text()}`);
    }
    const token = (await resp.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    await platform.auth().setData({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_type: 'Bearer',
      expires_in: String(token.expires_in ?? 3600),
    });
  } else {
    throw new Error('RingCentral credentials require jwt or botToken');
  }

  return { sdk, platform };
}

async function listChats(platform: RCPlatform, path: 'chats' | 'teams', limit: number): Promise<RcChatListItem[]> {
  const resp = await platform.get(`${TM_BASE}/${path}`, {
    recordCount: String(Math.min(Math.max(limit, 1), 250)),
  });
  const body = (await resp.json()) as { records?: RcChatListItem[] };
  return body.records ?? [];
}

async function sendPost(platform: RCPlatform, chatId: string, text: string): Promise<string | undefined> {
  const resp = await platform.post(`${TM_BASE}/chats/${chatId}/posts`, { text });
  const body = (await resp.json()) as { id?: string };
  return body.id;
}

function splitIntoPostChunks(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX_CHUNK) {
    chunks.push(text.slice(i, i + MAX_CHUNK));
  }
  return chunks;
}

function textFromOutbound(message: OutboundMessage): string | null {
  if (typeof message.content === 'string') return message.content;
  if (message.content && typeof message.content === 'object') {
    const text = (message.content as { text?: unknown; body?: unknown; message?: unknown }).text;
    if (typeof text === 'string') return text;
    const body = (message.content as { body?: unknown }).body;
    if (typeof body === 'string') return body;
    const nested = (message.content as { message?: unknown }).message;
    if (typeof nested === 'string') return nested;
  }
  return null;
}

class RingCentralAdapter implements ChannelAdapter {
  readonly supportsThreads = false;
  readonly channelType: string;
  readonly name: string;

  private connected = false;
  private botExtId: string | undefined;
  private platform: RCPlatform | undefined;
  private subscription: RcWsSubscription | undefined;
  private sentPostIds = new Map<string, number>();
  private lastOwnerIdByChat = new Map<string, string>();

  constructor(
    private readonly mode: 'owner' | 'bot',
    private readonly creds: RCCredentials,
  ) {
    this.channelType = mode === 'owner' ? 'rc' : 'rcb';
    this.name = mode === 'owner' ? 'ringcentral-owner' : 'ringcentral-bot';
  }

  async setup(config: ChannelSetup): Promise<void> {
    const { sdk, platform } = await createAuthenticatedSdk(this.creds);
    this.platform = platform;

    const subscriptions = new Subscriptions({ sdk });
    await (subscriptions as unknown as { init?: () => Promise<void> }).init?.();

    try {
      const resp = await platform.get('/restapi/v1.0/account/~/extension/~');
      const me = (await resp.json()) as { id?: string | number };
      this.botExtId = me?.id ? String(me.id) : undefined;
    } catch (err) {
      log.warn('RingCentral connected but extension lookup failed', { channel: this.channelType, err });
    }

    const sub = subscriptions.createSubscription();
    sub.setEventFilters(['/restapi/v1.0/glip/posts']);
    sub.on(sub.events.notification, (event: unknown) => {
      void this.handleEvent(event, config).catch((err) =>
        log.error('RingCentral event handler failed', { channel: this.channelType, err }),
      );
    });
    this.subscription = (await sub.register()) as RcWsSubscription;

    this.connected = true;
    log.info('RingCentral channel started', { channel: this.channelType, botExtId: this.botExtId });
  }

  async teardown(): Promise<void> {
    this.connected = false;
    const subscription = this.subscription;
    this.subscription = undefined;
    try {
      await subscription?.revoke?.();
    } catch (err) {
      log.warn('RingCentral subscription revoke failed', { channel: this.channelType, err });
      subscription?.remove?.();
    }
    await subscription?.wse?.disconnect?.();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    const text = textFromOutbound(message);
    if (!text) return undefined;
    if (!this.platform) throw new Error('RingCentral channel is not connected');

    let lastPostId: string | undefined;
    const chatId = this.normalizeChatId(platformId);
    const sendPlatform = await this.getSendPlatform(chatId);
    for (const chunk of splitIntoPostChunks(text)) {
      lastPostId = await sendPost(sendPlatform, chatId, chunk);
      if (lastPostId) this.trackSent(lastPostId);
    }
    return lastPostId;
  }

  async syncConversations(): Promise<ConversationInfo[]> {
    if (!this.platform) return [];
    const [chats, teams] = await Promise.all([listChats(this.platform, 'chats', 250), listChats(this.platform, 'teams', 250)]);
    return [...chats, ...teams]
      .filter((chat): chat is RcChatListItem & { id: string } => typeof chat.id === 'string')
      .map((chat) => ({
        platformId: this.formatPlatformId(chat.id),
        name: chat.name || chat.id,
        isGroup: chat.type?.toLowerCase() !== 'direct',
      }));
  }

  async resolveChannelName(platformId: string): Promise<string | null> {
    if (!this.platform) return null;
    const chatId = this.normalizeChatId(platformId);
    const matches = await this.syncConversations();
    return matches.find((chat) => chat.platformId === this.formatPlatformId(chatId))?.name ?? null;
  }

  private async handleEvent(event: unknown, config: ChannelSetup): Promise<void> {
    const raw = event as { body?: RcPostBody; ownerId?: string | number };
    const body = raw.body;
    if (!body || body.eventType !== 'PostAdded' || !body.text || !body.groupId) return;

    if (raw.ownerId !== undefined && raw.ownerId !== null) {
      this.lastOwnerIdByChat.set(body.groupId, String(raw.ownerId));
    } else if (body.ownerId !== undefined && body.ownerId !== null) {
      this.lastOwnerIdByChat.set(body.groupId, String(body.ownerId));
    }

    if (body.id && this.isOwnPost(body.id)) return;

    const senderId = body.creatorId ?? '';
    const sender = senderId ? await this.resolveUser(senderId) : 'unknown';
    const mentionToken = this.botExtId ? `![:Person](${this.botExtId})` : '';
    const isMention = !!mentionToken && body.text.includes(mentionToken);
    const text = isMention ? body.text.replaceAll(mentionToken, `@${ASSISTANT_NAME}`) : body.text;
    const timestamp = body.creationTime ? new Date(body.creationTime).toISOString() : new Date().toISOString();

    const platformId = this.formatPlatformId(body.groupId);
    config.onMetadata(platformId, undefined, true);
    await config.onInbound(platformId, null, {
      id: body.id ?? `rc-${Date.now()}`,
      kind: 'chat',
      timestamp,
      isMention,
      isGroup: true,
      content: {
        text,
        sender,
        senderId: senderId ? `${this.channelType}:${senderId}` : this.channelType,
      },
    });
  }

  private normalizeChatId(chatRef: string): string {
    if (chatRef.startsWith('rcb:')) return chatRef.slice(4);
    if (chatRef.startsWith('rc:')) return chatRef.slice(3);
    return chatRef;
  }

  private formatPlatformId(chatId: string): string {
    const raw = this.normalizeChatId(chatId);
    return `${this.channelType}:${raw}`;
  }

  private trackSent(postId: string): void {
    const now = Date.now();
    this.sentPostIds.set(postId, now + SENT_TTL_MS);
    for (const [id, expires] of this.sentPostIds) {
      if (now > expires) this.sentPostIds.delete(id);
    }
  }

  private isOwnPost(postId: string): boolean {
    const expires = this.sentPostIds.get(postId);
    if (!expires) return false;
    if (Date.now() > expires) {
      this.sentPostIds.delete(postId);
      return false;
    }
    return true;
  }

  private async resolveUser(userId: string): Promise<string> {
    if (!this.platform) return userId;
    try {
      const resp = await this.platform.get(`/restapi/v1.0/account/~/extension/${userId}`);
      const user = (await resp.json()) as { firstName?: string; lastName?: string; email?: string };
      return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || userId;
    } catch {
      return userId;
    }
  }

  private async getSendPlatform(chatId: string): Promise<RCPlatform> {
    if (!this.creds.botToken) {
      if (!this.platform) throw new Error('RingCentral channel is not connected');
      return this.platform;
    }

    const ownerId = this.lastOwnerIdByChat.get(chatId);
    const ownerScopedToken =
      ownerId && this.creds.botTokensByOwnerId ? this.creds.botTokensByOwnerId[ownerId] : undefined;
    if (!ownerScopedToken || ownerScopedToken === this.creds.botToken) {
      if (!this.platform) throw new Error('RingCentral channel is not connected');
      return this.platform;
    }

    return createAuthenticatedSdk({ ...this.creds, botToken: ownerScopedToken }).then(({ platform }) => platform);
  }
}

function registration(mode: 'owner' | 'bot'): ChannelRegistration {
  return {
    factory() {
      const creds = loadCredentials(mode);
      return creds ? new RingCentralAdapter(mode, creds) : null;
    },
  };
}

registerChannelAdapter('ringcentral-owner', registration('owner'));
registerChannelAdapter('ringcentral-bot', registration('bot'));
