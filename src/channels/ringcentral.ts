/**
 * RingCentral Team Messaging NanoClaw channel.
 *
 * Self-contained: uses @ringcentral/sdk + @rc-ex/ws + @ringcentral/subscriptions
 * directly. No dependency on openclaw-ringcentral at runtime.
 *
 * Source: openclaw-ringcentral/nanoclaw/channel.ts (feat/nanoclaw-channel branch)
 *
 * Required .env keys:
 *   RC_CLIENT_ID      RingCentral app client ID
 *   RC_CLIENT_SECRET  RingCentral app client secret
 *   RC_JWT            JWT token
 *   RC_SERVER         (optional) defaults to https://platform.ringcentral.com
 */

import { createRequire } from 'module';
import { SDK } from '@ringcentral/sdk';
import { Subscriptions } from '@ringcentral/subscriptions';

// @rc-ex/ws ships ESM that imports @rc-ex/core sub-paths, which Node's ESM
// translator fails to resolve in our build. Force CJS to avoid the issue.
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const RcWsExtension = _require('@rc-ex/ws');

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { autoRegisterContact } from '../rc-auto-register.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

const WebSocketExtension = RcWsExtension.default ?? RcWsExtension;
type WsExtInstance = InstanceType<typeof WebSocketExtension>;
type RCSdk = InstanceType<typeof SDK>;
type RCPlatform = ReturnType<RCSdk['platform']>;

interface RCCredentials {
  clientId: string;
  clientSecret: string;
  jwt?: string;
  botToken?: string;
  server: string;
}

export interface RcChatSummary {
  jid: string;
  chatId: string;
  name: string;
}

export interface RcChatMessage {
  id: string;
  text: string;
  creatorId: string;
  creatorName: string;
  createdAt: string;
}

export interface RcChatTranscript {
  jid: string;
  chatId: string;
  name: string;
  messages: RcChatMessage[];
}

// ─── SDK singleton cache ─────────────────────────────────────────────────────

const sdkCache = new Map<
  string,
  { sdk: RCSdk; platform: RCPlatform; creds: RCCredentials }
>();

async function getSDK(creds: RCCredentials): Promise<{
  sdk: RCSdk;
  platform: RCPlatform;
}> {
  const key = `${creds.clientId}:${creds.server}`;
  const cached = sdkCache.get(key);

  const cacheToken = creds.botToken ?? creds.jwt ?? '';
  if (
    cached &&
    (cached.creds.botToken ?? cached.creds.jwt ?? '') === cacheToken
  ) {
    const loggedIn = creds.botToken
      ? !!(await cached.platform.auth().data()).access_token
      : await cached.platform.loggedIn().catch(() => false);
    if (loggedIn) return cached;
  }

  const sdk = new SDK({
    server: creds.server,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  });
  const platform = sdk.platform();

  if (creds.botToken) {
    // Bot Add-in: set token directly (no JWT login)
    await platform.auth().setData({
      access_token: creds.botToken,
      token_type: 'Bearer',
      expires_in: String(3600 * 24 * 365), // treat as long-lived; refresh manually if expired
    });
  } else if (creds.jwt) {
    // FIX: RingCentral SDK's platform.login({ jwt }) sends client credentials incorrectly.
    // Must use Basic Auth header instead of passing client_id/secret in request body.
    // Manual token exchange using fetch with correct auth header.
    const https = await import('https');
    const authString = Buffer.from(
      `${creds.clientId}:${creds.clientSecret}`,
    ).toString('base64');

    const postData = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: creds.jwt,
    }).toString();

    const tokenResponse = await new Promise<{
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    }>((resolve, reject) => {
      const req = https.request(
        `${creds.server}/restapi/oauth/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${authString}`,
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(data) as {
                access_token?: string;
                refresh_token?: string;
                expires_in?: number;
                error?: string;
              };
              if (json.access_token) {
                resolve({
                  access_token: json.access_token,
                  refresh_token: json.refresh_token,
                  expires_in: json.expires_in ?? 3600,
                });
              } else {
                reject(
                  new Error(`JWT token exchange failed: ${json.error ?? data}`),
                );
              }
            } catch (e) {
              reject(e);
            }
          });
        },
      );

      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    // Set the obtained token in the platform auth
    await platform.auth().setData({
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      token_type: 'Bearer',
      expires_in: String(tokenResponse.expires_in),
    });
  } else {
    throw new Error('Either RC_JWT or RC_BOT_TOKEN must be set in .env');
  }

  const entry = { sdk, platform, creds };
  sdkCache.set(key, entry);
  return entry;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

const TM_BASE = '/team-messaging/v1';

async function sendPost(
  platform: RCPlatform,
  chatId: string,
  text: string,
): Promise<string | undefined> {
  const resp = await platform.post(`${TM_BASE}/chats/${chatId}/posts`, {
    text,
  });
  const body = (await resp.json()) as { id?: string };
  return body?.id;
}

async function fetchUser(
  platform: RCPlatform,
  userId: string,
): Promise<{ firstName?: string; lastName?: string; email?: string } | null> {
  try {
    const resp = await platform.get(`${TM_BASE}/persons/${userId}`);
    return (await resp.json()) as {
      firstName?: string;
      lastName?: string;
      email?: string;
    };
  } catch {
    return null;
  }
}

async function listChats(
  platform: RCPlatform,
  limit = 250,
): Promise<Array<{ id?: string; name?: string }>> {
  try {
    const resp = await platform.get(`${TM_BASE}/chats`, {
      recordCount: String(limit),
    });
    const body = (await resp.json()) as {
      records?: Array<{ id?: string; name?: string }>;
    };
    return body?.records ?? [];
  } catch {
    return [];
  }
}

async function getChat(
  platform: RCPlatform,
  chatId: string,
): Promise<{ id?: string; name?: string } | null> {
  try {
    const resp = await platform.get(`${TM_BASE}/chats/${chatId}`);
    return (await resp.json()) as { id?: string; name?: string };
  } catch {
    return null;
  }
}

async function listPosts(
  platform: RCPlatform,
  chatId: string,
  limit = 20,
): Promise<
  Array<{
    id?: string;
    text?: string;
    creatorId?: string;
    creationTime?: string;
  }>
> {
  try {
    const resp = await platform.get(`${TM_BASE}/chats/${chatId}/posts`, {
      recordCount: String(limit),
    });
    const body = (await resp.json()) as {
      records?: Array<{
        id?: string;
        text?: string;
        creatorId?: string;
        creationTime?: string;
      }>;
    };
    return body.records ?? [];
  } catch {
    return [];
  }
}

// ─── Channel opts ─────────────────────────────────────────────────────────────

export interface RingCentralChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /**
   * Called when auto-registration creates a new group so the caller can
   * update its in-memory registered groups map immediately.
   */
  onRegisterGroup?: (jid: string, group: RegisteredGroup) => void;
  /** Channel name for logging/identification. Defaults to 'rc'. */
  name?: string;
  /** JID prefix for chats on this channel. Defaults to 'rc:'. */
  jidPrefix?: string;
  /**
   * Whether this channel should auto-register unknown contacts.
   * Only the bot-token channel (rcb:) should do this.
   * Defaults to false.
   */
  autoRegister?: boolean;
  /**
   * Called when the account owner (isBotMsg=true) sends a toggle command.
   * Only the JWT/user channel (rc: prefix) should provide this callback.
   */
  onOwnerCommand?: (cmd: {
    action: 'set_auto_assist';
    value: boolean;
  }) => Promise<void>;
  /** Explicit credentials. If omitted, reads from env (RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT / RC_BOT_TOKEN). */
  creds?: {
    clientId: string;
    clientSecret: string;
    jwt?: string;
    botToken?: string;
    server?: string;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SERVER = 'https://platform.ringcentral.com';
const MAX_CHUNK = 4000;
const INBOUND_DEDUP_TTL = 2 * 60_000;
const SENT_TTL = 60_000;

// ─── RingCentralChannel ───────────────────────────────────────────────────────

export class RingCentralChannel implements Channel {
  readonly name: string;
  private readonly jidPrefix: string;

  private creds: RCCredentials;
  private connected = false;
  private botExtId: string | undefined;

  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;

  private userCache = new Map<string, string>();
  private inboundDedup = new Map<string, number>();
  private sentIds = new Map<string, number>();

  private wsExt: WsExtInstance | undefined;
  private platform: RCPlatform | undefined;

  private opts: RingCentralChannelOpts;

  constructor(opts: RingCentralChannelOpts) {
    this.opts = opts;
    this.name = opts.name ?? 'rc';
    this.jidPrefix = opts.jidPrefix ?? 'rc:';

    if (opts.creds) {
      // Explicit credentials provided by caller
      const { clientId, clientSecret, jwt, botToken, server } = opts.creds;
      if (!clientId || !clientSecret) {
        throw new Error(
          'RC credentials must include clientId and clientSecret',
        );
      }
      if (!jwt && !botToken) {
        throw new Error('RC credentials must include jwt or botToken');
      }
      this.creds = {
        clientId,
        clientSecret,
        jwt,
        botToken,
        server: server ?? DEFAULT_SERVER,
      };
    } else {
      // Fall back to reading from env (legacy single-channel path)
      const env = readEnvFile([
        'RC_CLIENT_ID',
        'RC_CLIENT_SECRET',
        'RC_JWT',
        'RC_BOT_TOKEN',
        'RC_SERVER',
      ]);
      if (!env.RC_CLIENT_ID || !env.RC_CLIENT_SECRET) {
        throw new Error(
          'RC_CLIENT_ID and RC_CLIENT_SECRET must be set in .env',
        );
      }
      if (!env.RC_JWT && !env.RC_BOT_TOKEN) {
        throw new Error('Either RC_JWT or RC_BOT_TOKEN must be set in .env');
      }
      this.creds = {
        clientId: env.RC_CLIENT_ID,
        clientSecret: env.RC_CLIENT_SECRET,
        jwt: env.RC_JWT,
        botToken: env.RC_BOT_TOKEN,
        server: env.RC_SERVER || DEFAULT_SERVER,
      };
    }
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(this.jidPrefix);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    const { sdk, platform } = await getSDK(this.creds);
    this.platform = platform;

    // Install WebSocket extension with auto-reconnect
    const subscriptions = new Subscriptions({ sdk });
    await (subscriptions as unknown as { init?: () => Promise<void> }).init?.();

    const wsExt = new WebSocketExtension({
      debugMode: false,
      autoRecover: {
        enabled: true,
        checkInterval: (r: number) => Math.min(5000 * Math.pow(2, r), 300_000),
        pingServerInterval: 60_000,
      },
    });

    const rc = (
      subscriptions as unknown as {
        rc?: {
          installExtension: (ext: unknown) => Promise<void>;
        };
      }
    ).rc;
    if (!rc?.installExtension) {
      throw new Error('@rc-ex/ws installExtension not found');
    }
    await rc.installExtension(wsExt);
    await wsExt.connect(false);
    this.wsExt = wsExt;

    // Resolve bot's own extension ID for self-message detection
    try {
      const resp = await platform.get('/restapi/v1.0/account/~/extension/~');
      const me = (await resp.json()) as { id?: string | number };
      this.botExtId = me?.id ? String(me.id) : undefined;
      logger.info({ botExtId: this.botExtId }, 'Connected to RingCentral TM');
    } catch (err) {
      logger.warn({ err }, 'RC connected but failed to get bot extension ID');
    }

    // Subscribe to new post events
    const sub = subscriptions.createSubscription();
    sub.setEventFilters(['/restapi/v1.0/glip/posts']);
    sub.on(sub.events.notification, (event: unknown) => {
      this.handleEvent(event).catch((err) =>
        logger.error({ err }, 'RC event handler error'),
      );
    });
    await sub.register();

    this.connected = true;
    await this.flushOutgoingQueue();
    await this.syncChatMetadata();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      await (
        this.wsExt as { disconnect?: () => Promise<void> }
      )?.disconnect?.();
    } catch {
      // Best-effort
    }
  }

  // RingCentral TM has no typing indicator API
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op
  }

  // ─── Sending ────────────────────────────────────────────────────────────────

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.slice(this.jidPrefix.length);

    if (!this.connected || !this.platform) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'RC disconnected, message queued',
      );
      return;
    }

    try {
      // Chunk oversized messages
      const chunks =
        text.length <= MAX_CHUNK
          ? [text]
          : Array.from({ length: Math.ceil(text.length / MAX_CHUNK) }, (_, i) =>
              text.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
            );

      for (const chunk of chunks) {
        const postId = await sendPost(this.platform, chatId, chunk);
        if (postId) this.trackSent(postId);
      }

      logger.info({ jid, length: text.length }, 'RC message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'RC send failed, queued',
      );
    }
  }

  jidForChatId(chatId: string): string {
    return `${this.jidPrefix}${chatId}`;
  }

  normalizeChatId(chatRef: string): string {
    if (chatRef.startsWith('rc:')) return chatRef.slice(3);
    if (chatRef.startsWith('rcb:')) return chatRef.slice(4);
    return chatRef;
  }

  async listChatsForAgent(
    query?: string,
    limit = 50,
  ): Promise<RcChatSummary[]> {
    if (!this.platform) throw new Error('RC channel is not connected');

    const cappedLimit = Math.min(Math.max(limit, 1), 250);
    const chats = await listChats(this.platform, Math.min(cappedLimit * 3, 250));
    const normalizedQuery = query?.trim().toLowerCase();

    return chats
      .filter((chat) => chat.id && chat.name)
      .map((chat) => ({
        jid: this.jidForChatId(chat.id!),
        chatId: chat.id!,
        name: chat.name!,
      }))
      .filter((chat) => {
        if (!normalizedQuery) return true;
        return (
          chat.chatId.toLowerCase().includes(normalizedQuery) ||
          chat.name.toLowerCase().includes(normalizedQuery)
        );
      })
      .slice(0, cappedLimit);
  }

  async readMessagesForAgent(
    chatRef: string,
    limit = 20,
  ): Promise<RcChatTranscript> {
    if (!this.platform) throw new Error('RC channel is not connected');

    const chatId = this.normalizeChatId(chatRef);
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    const chat = await getChat(this.platform, chatId);
    const posts = await listPosts(this.platform, chatId, cappedLimit);

    const messages = await Promise.all(
      posts.map(async (post) => {
        const creatorId = post.creatorId ?? '';
        const creatorName =
          creatorId && creatorId === this.botExtId
            ? ASSISTANT_NAME
            : ((creatorId ? await this.resolveUser(creatorId) : undefined) ??
              creatorId ??
              'unknown');

        return {
          id: post.id ?? '',
          text: post.text ?? '',
          creatorId,
          creatorName,
          createdAt: post.creationTime
            ? new Date(post.creationTime).toISOString()
            : new Date().toISOString(),
        };
      }),
    );

    return {
      jid: this.jidForChatId(chatId),
      chatId,
      name: chat?.name ?? this.jidForChatId(chatId),
      messages: messages.reverse(),
    };
  }

  async sendMessageForAgent(
    chatRef: string,
    text: string,
  ): Promise<{ jid: string; chatId: string; postId?: string }> {
    if (!this.platform) throw new Error('RC channel is not connected');

    const chatId = this.normalizeChatId(chatRef);
    const postId = await sendPost(this.platform, chatId, text);
    if (postId) this.trackSent(postId);

    logger.info({ jid: this.jidForChatId(chatId), length: text.length }, 'RC SDK message sent');

    return {
      jid: this.jidForChatId(chatId),
      chatId,
      postId,
    };
  }

  // ─── Inbound ─────────────────────────────────────────────────────────────────

  private async handleEvent(event: unknown): Promise<void> {
    const body = (event as { body?: Record<string, unknown> })?.body;
    if (!body || body.eventType !== 'PostAdded') return;

    const text = body.text as string | undefined;
    if (!text) return;

    const postId = body.id as string | undefined;
    const chatId = body.groupId as string | undefined;
    const creatorId = body.creatorId as string | undefined;
    const timestamp = body.creationTime
      ? new Date(body.creationTime as string).toISOString()
      : new Date().toISOString();

    if (!chatId) return;
    if (postId && this.isDup(postId)) return;
    if (postId && this.isOwn(postId)) return;

    const isBotMsg =
      !!creatorId && this.botExtId !== undefined && creatorId === this.botExtId;

    const jid = `${this.jidPrefix}${chatId}`;

    // Always report metadata for group discovery
    this.opts.onChatMetadata(jid, timestamp, undefined, this.name, true);

    // Owner command detection: Nasen's own messages (isBotMsg=true) can carry toggle
    // commands. Intercepted BEFORE DB storage so only the account owner can trigger them.
    if (isBotMsg && this.opts.onOwnerCommand) {
      const toggleMatch = text.match(
        /\b(enable|disable|turn\s+on|turn\s+off)\s+(auto[\s-]?assist|auto[\s-]?reply|auto[\s-]?response)\b/i,
      );
      if (toggleMatch) {
        const enable = /enable|turn\s+on/i.test(toggleMatch[1]);
        await this.opts.onOwnerCommand({
          action: 'set_auto_assist',
          value: enable,
        });
        return; // do not store or route this message
      }
    }

    // Resolve sender name early — needed for auto-registration lookup
    const senderName = isBotMsg
      ? ASSISTANT_NAME
      : ((creatorId ? await this.resolveUser(creatorId) : undefined) ??
        creatorId ??
        'unknown');

    // Detect bot @mention — indicates a group/team chat interaction.
    // In RC the mention format is ![:Person](extensionId).
    const botMention = this.botExtId ? `![:Person](${this.botExtId})` : null;
    const isGroupMention = !!botMention && text.includes(botMention);

    let groups = this.opts.registeredGroups();
    if (!groups[jid]) {
      // Only the bot-token channel should auto-register unknown contacts.
      // The JWT/user channel sees all RC events and must not register them.
      if (!isBotMsg && this.opts.autoRegister) {
        if (!isGroupMention) {
          // Someone DM'd the bot extension directly. This bot is personal and
          // only participates in team chats. Reply and drop the message.
          await this.sendMessage(
            jid,
            "This is Nasen's personal mate, not accepting DMs.",
          );
          return;
        }
        const group = autoRegisterContact(
          jid,
          senderName,
          chatId,
          isGroupMention,
          GROUPS_DIR,
        );
        if (!group) return;
        // Update in-memory state immediately so this message is processed
        this.opts.onRegisterGroup?.(jid, group);
        groups = this.opts.registeredGroups();
        if (!groups[jid]) return;
      } else {
        return;
      }
    }

    // Translate RC @mention (![:Person](id)) → @AssistantName for trigger matching
    let content = text;
    if (this.botExtId && !isBotMsg) {
      const mention = `![:Person](${this.botExtId})`;
      if (content.includes(mention) && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    this.opts.onMessage(jid, {
      id: postId ?? `rc-${Date.now()}`,
      chat_jid: jid,
      sender: creatorId ?? '',
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isBotMsg,
      is_bot_message: isBotMsg,
    });
  }

  // ─── Chat metadata ──────────────────────────────────────────────────────────

  async syncChatMetadata(): Promise<void> {
    if (!this.platform) return;
    try {
      logger.info('Syncing RC chat metadata...');
      const chats = await listChats(this.platform);
      let count = 0;
      for (const chat of chats) {
        if (chat.id && chat.name) {
          updateChatName(`${this.jidPrefix}${chat.id}`, chat.name);
          count++;
        }
      }
      logger.info({ count }, 'RC chat metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync RC chat metadata');
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private trackSent(postId: string): void {
    const now = Date.now();
    this.sentIds.set(postId, now + SENT_TTL);
    for (const [id, exp] of this.sentIds) {
      if (now > exp) this.sentIds.delete(id);
    }
  }

  private isOwn(postId: string): boolean {
    const exp = this.sentIds.get(postId);
    if (exp === undefined) return false;
    if (Date.now() > exp) {
      this.sentIds.delete(postId);
      return false;
    }
    return true;
  }

  private isDup(postId: string): boolean {
    const now = Date.now();
    const exp = this.inboundDedup.get(postId);
    if (exp !== undefined && now < exp) return true;
    this.inboundDedup.set(postId, now + INBOUND_DEDUP_TTL);
    for (const [id, e] of this.inboundDedup) {
      if (now > e) this.inboundDedup.delete(id);
    }
    return false;
  }

  private async resolveUser(userId: string): Promise<string | undefined> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;
    if (!this.platform) return undefined;
    const user = await fetchUser(this.platform, userId);
    const name =
      [user?.firstName, user?.lastName].filter(Boolean).join(' ') ||
      user?.email;
    if (name) this.userCache.set(userId, name);
    return name;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing RC queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const chatId = item.jid.slice(this.jidPrefix.length);
        if (this.platform) {
          const postId = await sendPost(this.platform, chatId, item.text);
          if (postId) this.trackSent(postId);
        }
        logger.info({ jid: item.jid }, 'Queued RC message sent');
      }
    } finally {
      this.flushing = false;
    }
  }
}
