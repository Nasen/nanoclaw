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
import {
  findChatParticipantsByName,
  findChatsByPrefix,
  findChatsByQuery,
  findOpaqueChatsByPrefix,
  updateChatName,
} from '../db.js';
import { readEnvFile, readEnvFileByPrefix } from '../env.js';
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
  botTokensByOwnerId?: Record<string, string>;
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

export interface RcChatMember {
  id?: string;
  name?: string;
  email?: string;
  [key: string]: unknown;
}

export interface RcPresence {
  extensionId?: string;
  userStatus?: string;
  dndStatus?: string;
  [key: string]: unknown;
}

export interface RcPresenceUpdateInput {
  userStatus?: string;
  dndStatus?: string;
}

export interface RcExtensionSummary {
  id?: string | number;
  extensionNumber?: string;
  name?: string;
  email?: string;
  contact?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface RcContact {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  company?: string;
  jobTitle?: string;
  [key: string]: unknown;
}

interface RcDirectoryEntry {
  id?: string | number;
  type?: string;
  status?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  extensionNumber?: string;
  [key: string]: unknown;
}

export interface RcContactInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  company?: string;
  jobTitle?: string;
  businessPhone?: string;
  mobilePhone?: string;
  homePhone?: string;
  otherPhone?: string;
}

export interface RcPhoneNumber {
  phoneNumber?: string;
  usageType?: string;
  type?: string;
  extension?: {
    id?: string | number;
    extensionNumber?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface RcChatListItem {
  id?: string;
  name?: string;
  type?: string;
  members?: Array<{
    id?: string;
  }>;
}

interface RcChatListPage {
  records?: RcChatListItem[];
  navigation?: {
    nextPageToken?: string;
    prevPageToken?: string;
  };
}

function extractOwnerScopedBotTokens(
  values: Record<string, string>,
): Record<string, string> | undefined {
  const entries = Object.entries(values).map(([key, value]) => [
    key.slice('RC_BOT_TOKEN_OWNER_'.length),
    value,
  ]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// ─── SDK singleton cache ─────────────────────────────────────────────────────

const sdkCache = new Map<
  string,
  { sdk: RCSdk; platform: RCPlatform; creds: RCCredentials }
>();
const globalSentPostIds = new Map<string, number>();

async function createAuthenticatedSdk(creds: RCCredentials): Promise<{
  sdk: RCSdk;
  platform: RCPlatform;
}> {
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

  return { sdk, platform };
}

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

  const { sdk, platform } = await createAuthenticatedSdk(creds);
  const entry = { sdk, platform, creds };
  sdkCache.set(key, entry);
  return entry;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

const TM_BASE = '/team-messaging/v1';

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([, current]) => current !== undefined && current !== '',
    ),
  ) as T;
}

function matchesQuery(
  query: string | undefined,
  values: Array<string | number | undefined>,
): boolean {
  const normalizedQuery = query?.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return values.some((value) =>
    String(value ?? '')
      .toLowerCase()
      .includes(normalizedQuery),
  );
}

function shouldRetryRcRead(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('401') ||
    message.includes('403') ||
    message.includes('404') ||
    /unauthorized/i.test(message) ||
    /forbidden/i.test(message) ||
    /not found/i.test(message) ||
    /resource not found/i.test(message)
  );
}

function isRcNotFound(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /404/i.test(message) || /not found/i.test(message);
}

function extractPersonIdFromRef(ref: string): string | undefined {
  const trimmed = ref.trim();
  const mentionMatch = trimmed.match(/^!\[:Person\]\((\d+)\)$/i);
  if (mentionMatch) return mentionMatch[1];
  return /^\d+$/.test(trimmed) ? trimmed : undefined;
}

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

async function verifySentPostCreator(
  platform: RCPlatform,
  chatId: string,
  postId: string,
): Promise<string | undefined> {
  try {
    const posts = await listPosts(platform, chatId, 10);
    return posts.find((post) => post.id === postId)?.creatorId;
  } catch {
    return undefined;
  }
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
  options: {
    limit?: number;
    query?: string;
    fetchAll?: boolean;
    pageSize?: number;
    suppressErrors?: boolean;
  } = {},
): Promise<RcChatListItem[]> {
  try {
    return _listChatsPaginated(async (pageToken, pageSize) => {
      const resp = await platform.get(
        `${TM_BASE}/chats`,
        stripUndefined({
          recordCount: String(pageSize),
          pageToken,
        }),
      );
      return (await resp.json()) as RcChatListPage;
    }, options);
  } catch (err) {
    if (options.suppressErrors) {
      logger.warn({ err }, 'Failed to list RC chats');
      return [];
    }
    throw err;
  }
}

async function listTeams(
  platform: RCPlatform,
  options: {
    limit?: number;
    query?: string;
    fetchAll?: boolean;
    pageSize?: number;
    suppressErrors?: boolean;
  } = {},
): Promise<RcChatListItem[]> {
  try {
    return _listChatsPaginated(async (pageToken, pageSize) => {
      const resp = await platform.get(
        `${TM_BASE}/teams`,
        stripUndefined({
          recordCount: String(pageSize),
          pageToken,
        }),
      );
      return (await resp.json()) as RcChatListPage;
    }, options);
  } catch (err) {
    if (options.suppressErrors) {
      logger.warn({ err }, 'Failed to list RC teams');
      return [];
    }
    throw err;
  }
}

/**
 * @internal - exported for testing.
 * RingCentral chat search must paginate because older teams may not appear on
 * the first page; otherwise they remain searchable only by raw JID.
 */
export async function _listChatsPaginated(
  fetchPage: (
    pageToken: string | undefined,
    pageSize: number,
  ) => Promise<RcChatListPage>,
  options: {
    limit?: number;
    query?: string;
    fetchAll?: boolean;
    pageSize?: number;
  } = {},
): Promise<RcChatListItem[]> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 250, 1), 250);
  const limit = Math.max(options.limit ?? pageSize, 1);
  const fetchAll = options.fetchAll ?? false;
  const shouldDeepSearch = fetchAll || !!options.query?.trim();
  const seenPageTokens = new Set<string>();
  const seenChatIds = new Set<string>();
  const pendingPageTokens: Array<string | undefined> = [undefined];
  const results: RcChatListItem[] = [];

  for (let page = 0; page < 50 && pendingPageTokens.length > 0; page++) {
    const pageToken = pendingPageTokens.shift();
    const body = await fetchPage(pageToken, pageSize);
    const records = body.records ?? [];

    for (const chat of records) {
      if (chat.id && seenChatIds.has(chat.id)) continue;
      if (chat.id) seenChatIds.add(chat.id);
      if (!matchesQuery(options.query, [chat.id, chat.name])) continue;
      results.push(chat);
      if (!fetchAll && results.length >= limit) {
        return results.slice(0, limit);
      }
    }

    if (!shouldDeepSearch) {
      break;
    }

    for (const nextToken of [
      body.navigation?.prevPageToken,
      body.navigation?.nextPageToken,
    ]) {
      if (!nextToken || seenPageTokens.has(nextToken)) continue;
      seenPageTokens.add(nextToken);
      pendingPageTokens.push(nextToken);
    }
  }

  return fetchAll ? results : results.slice(0, limit);
}

function mergeChatListItems(...lists: RcChatListItem[][]): RcChatListItem[] {
  const merged = new Map<string, RcChatListItem>();
  for (const list of lists) {
    for (const item of list) {
      if (!item.id) continue;
      const existing = merged.get(item.id);
      if (!existing) {
        merged.set(item.id, item);
        continue;
      }
      merged.set(item.id, {
        id: item.id,
        name: existing.name || item.name,
      });
    }
  }
  return Array.from(merged.values());
}

async function getChat(
  platform: RCPlatform,
  chatId: string,
): Promise<RcChatListItem | null> {
  try {
    const resp = await platform.get(`${TM_BASE}/chats/${chatId}`);
    return (await resp.json()) as RcChatListItem;
  } catch {
    return null;
  }
}

async function getTeam(
  platform: RCPlatform,
  teamId: string,
): Promise<{ id?: string; name?: string } | null> {
  try {
    const resp = await platform.get(`${TM_BASE}/teams/${teamId}`);
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
  } catch (err) {
    logger.warn({ chatId, err }, 'Failed to list RC chat posts');
    throw err;
  }
}

async function listChatMembers(
  platform: RCPlatform,
  chatId: string,
  limit = 100,
): Promise<RcChatMember[]> {
  const resp = await platform.get(`${TM_BASE}/chats/${chatId}/members`, {
    recordCount: String(limit),
  });
  const body = (await resp.json()) as { records?: RcChatMember[] };
  return body.records ?? [];
}

async function getPresence(
  platform: RCPlatform,
  extensionId = '~',
): Promise<RcPresence> {
  const resp = await platform.get(
    `/restapi/v1.0/account/~/extension/${extensionId}/presence`,
  );
  return (await resp.json()) as RcPresence;
}

async function setPresence(
  platform: RCPlatform,
  update: RcPresenceUpdateInput,
): Promise<RcPresence> {
  const resp = await platform.put(
    '/restapi/v1.0/account/~/extension/~/presence',
    stripUndefined(update),
  );
  return (await resp.json()) as RcPresence;
}

async function getExtension(
  platform: RCPlatform,
  extensionId = '~',
): Promise<RcExtensionSummary> {
  const resp = await platform.get(
    `/restapi/v1.0/account/~/extension/${extensionId}`,
  );
  return (await resp.json()) as RcExtensionSummary;
}

async function listExtensions(
  platform: RCPlatform,
  limit = 100,
): Promise<RcExtensionSummary[]> {
  const resp = await platform.get('/restapi/v1.0/account/~/extension', {
    page: '1',
    perPage: String(limit),
  });
  const body = (await resp.json()) as { records?: RcExtensionSummary[] };
  return body.records ?? [];
}

async function searchDirectoryEntries(
  platform: RCPlatform,
  query: string,
  limit = 20,
): Promise<RcDirectoryEntry[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const results: RcDirectoryEntry[] = [];
  const perPage = 250;
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const resp = await platform.get(
      '/restapi/v1.0/account/~/directory/entries',
      {
        page: String(page),
        perPage: String(perPage),
      },
    );
    const body = (await resp.json()) as {
      records?: RcDirectoryEntry[];
      paging?: {
        totalPages?: number;
      };
    };
    totalPages = Math.max(body.paging?.totalPages ?? page, page);

    for (const entry of body.records ?? []) {
      const values = [
        entry.id ? String(entry.id) : undefined,
        entry.extensionNumber,
        entry.email,
        entry.firstName,
        entry.lastName,
        [entry.firstName, entry.lastName].filter(Boolean).join(' '),
      ];
      if (!matchesQuery(query, values)) continue;
      results.push(entry);
    }

    page += 1;
  }

  const scoreEntry = (entry: RcDirectoryEntry): number => {
    const fullName = [entry.firstName, entry.lastName]
      .filter(Boolean)
      .join(' ')
      .trim()
      .toLowerCase();
    const email = entry.email?.trim().toLowerCase();
    const extensionNumber = entry.extensionNumber?.trim().toLowerCase();
    const id = entry.id ? String(entry.id).toLowerCase() : undefined;

    if (fullName === normalizedQuery) return 0;
    if (email === normalizedQuery || extensionNumber === normalizedQuery) {
      return 1;
    }
    if (id === normalizedQuery) return 2;
    if (fullName.startsWith(normalizedQuery)) return 3;
    if (email?.startsWith(normalizedQuery)) return 4;
    return 5;
  };

  return results
    .sort((a, b) => {
      const statusScoreA = a.status === 'Enabled' ? 0 : 1;
      const statusScoreB = b.status === 'Enabled' ? 0 : 1;
      if (statusScoreA !== statusScoreB) return statusScoreA - statusScoreB;

      const scoreA = scoreEntry(a);
      const scoreB = scoreEntry(b);
      if (scoreA !== scoreB) return scoreA - scoreB;

      const nameA = [a.firstName, a.lastName].filter(Boolean).join(' ');
      const nameB = [b.firstName, b.lastName].filter(Boolean).join(' ');
      return nameA.localeCompare(nameB);
    })
    .slice(0, limit);
}

async function listContacts(
  platform: RCPlatform,
  limit = 100,
): Promise<RcContact[]> {
  const resp = await platform.get(
    '/restapi/v1.0/account/~/extension/~/address-book/contact',
    {
      page: '1',
      perPage: String(limit),
    },
  );
  const body = (await resp.json()) as { records?: RcContact[] };
  return body.records ?? [];
}

async function createContact(
  platform: RCPlatform,
  contact: RcContactInput,
): Promise<RcContact> {
  const resp = await platform.post(
    '/restapi/v1.0/account/~/extension/~/address-book/contact',
    stripUndefined(contact),
  );
  return (await resp.json()) as RcContact;
}

async function listPhoneNumbers(
  platform: RCPlatform,
  limit = 100,
): Promise<RcPhoneNumber[]> {
  const resp = await platform.get(
    '/restapi/v1.0/account/~/extension/~/phone-number',
    {
      page: '1',
      perPage: String(limit),
    },
  );
  const body = (await resp.json()) as { records?: RcPhoneNumber[] };
  return body.records ?? [];
}

async function getOrCreateConversation(
  platform: RCPlatform,
  memberIds: string[],
): Promise<RcChatListItem | null> {
  const resp = await platform.post(`${TM_BASE}/conversations`, {
    members: memberIds.map((id) => ({ id })),
  });
  return (await resp.json()) as RcChatListItem;
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
    action: 'set_auto_assist' | 'set_service_enabled';
    chatJid: string;
    value: boolean;
  }) => Promise<void>;
  /** Explicit credentials. If omitted, reads from env (RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT / RC_BOT_TOKEN). */
  creds?: {
    clientId: string;
    clientSecret: string;
    jwt?: string;
    botToken?: string;
    botTokensByOwnerId?: Record<string, string>;
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
  private lastOwnerIdByChat = new Map<string, string>();

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
        botTokensByOwnerId: opts.creds.botTokensByOwnerId,
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
      const ownerScopedBotTokens = extractOwnerScopedBotTokens(
        readEnvFileByPrefix('RC_BOT_TOKEN_OWNER_'),
      );
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
        botTokensByOwnerId: ownerScopedBotTokens,
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
        const {
          platform: sendPlatform,
          expectedCreatorId,
          ownerId,
        } = await this.getSendPlatform(chatId);
        const postId = await sendPost(sendPlatform, chatId, chunk);
        if (postId) {
          this.trackSent(postId);
          const creatorId = await verifySentPostCreator(
            sendPlatform,
            chatId,
            postId,
          );
          if (
            expectedCreatorId &&
            creatorId &&
            creatorId !== expectedCreatorId
          ) {
            throw new Error(
              `Bot-auth send resolved to creator ${creatorId}, expected ${expectedCreatorId}${ownerId ? ` (ownerId=${ownerId})` : ''}`,
            );
          }
          logger.info(
            {
              jid,
              postId,
              creatorId,
              connectedExtId: this.botExtId,
              ownerId,
            },
            'RC sent post verification',
          );
        }
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

  private findCachedChats(query: string, limit: number): RcChatSummary[] {
    return findChatsByQuery(query, {
      jidPrefix: this.jidPrefix,
      limit,
    }).map((chat) => ({
      jid: chat.jid,
      chatId: this.normalizeChatId(chat.jid),
      name: chat.name || chat.jid,
    }));
  }

  private findOpaqueCachedChats(limit: number): RcChatSummary[] {
    return findOpaqueChatsByPrefix(this.jidPrefix, limit).map((chat) => ({
      jid: chat.jid,
      chatId: this.normalizeChatId(chat.jid),
      name: chat.name || chat.jid,
    }));
  }

  private isOpaqueChatName(name: string | undefined, chatId: string): boolean {
    const trimmed = name?.trim();
    if (!trimmed) return true;

    const normalizedName = trimmed.toLowerCase();
    return (
      normalizedName === chatId.toLowerCase() ||
      normalizedName === this.jidForChatId(chatId).toLowerCase()
    );
  }

  private async resolveDirectChatName(
    platform: RCPlatform,
    chat: RcChatListItem | null,
  ): Promise<string | undefined> {
    if (!chat || chat.type?.toLowerCase() !== 'direct') return undefined;

    const otherMemberIds = (chat.members ?? [])
      .map((member) => member.id?.trim())
      .filter(
        (memberId): memberId is string =>
          !!memberId && memberId !== this.botExtId,
      );

    if (otherMemberIds.length !== 1) return undefined;
    return this.resolveUser(otherMemberIds[0], platform);
  }

  private async resolveChatDisplayName(
    platform: RCPlatform,
    chatId: string,
    rawName?: string,
    chatDetail?: RcChatListItem | null,
  ): Promise<string | undefined> {
    const initialName = rawName?.trim();
    const initialIsOpaque = this.isOpaqueChatName(initialName, chatId);
    const detail =
      chatDetail ?? (initialIsOpaque ? await getChat(platform, chatId) : null);

    const directChatName = await this.resolveDirectChatName(platform, detail);
    if (directChatName) {
      updateChatName(this.jidForChatId(chatId), directChatName);
      return directChatName;
    }

    const detailName = detail?.name?.trim();
    if (detailName && !this.isOpaqueChatName(detailName, chatId)) {
      updateChatName(this.jidForChatId(chatId), detailName);
      return detailName;
    }

    if (initialName && !initialIsOpaque) {
      updateChatName(this.jidForChatId(chatId), initialName);
      return initialName;
    }

    return initialName || detailName;
  }

  private async buildChatSummary(
    platform: RCPlatform,
    chatId: string,
    rawName?: string,
    chatDetail?: RcChatListItem | null,
  ): Promise<RcChatSummary> {
    const name =
      (await this.resolveChatDisplayName(
        platform,
        chatId,
        rawName,
        chatDetail,
      )) ?? this.jidForChatId(chatId);
    return {
      jid: this.jidForChatId(chatId),
      chatId,
      name,
    };
  }

  private looksLikeChatId(chatRef: string): boolean {
    return (
      chatRef.startsWith('rc:') ||
      chatRef.startsWith('rcb:') ||
      /^\d+$/.test(chatRef.trim())
    );
  }

  private async resolveDirectoryBackedDirectChats(
    query: string,
    limit: number,
  ): Promise<RcChatSummary[]> {
    if (!this.platform || !this.botExtId) return [];

    const candidates = await searchDirectoryEntries(
      this.platform,
      query,
      Math.min(Math.max(limit * 3, 10), 25),
    );
    const chats = new Map<string, RcChatSummary>();

    for (const candidate of candidates) {
      if (candidate.status && candidate.status !== 'Enabled') continue;
      const candidateId = candidate.id ? String(candidate.id) : undefined;
      if (!candidateId || candidateId === this.botExtId) continue;

      const fullName = [candidate.firstName, candidate.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      const existingMatches = await this.resolveOpaqueDirectChatsByMemberIds(
        new Map([[candidateId, fullName || candidate.email || candidateId]]),
        limit - chats.size,
      );
      for (const match of existingMatches) {
        chats.set(match.chatId, match);
        if (chats.size >= limit) break;
      }
      if (chats.size >= limit) break;
    }

    return Array.from(chats.values());
  }

  private async resolveConversationByMemberId(
    memberId: string,
    fallbackName?: string,
  ): Promise<RcChatSummary | undefined> {
    if (!this.platform || !this.botExtId) return undefined;
    if (!memberId || memberId === this.botExtId) return undefined;

    const conversation = await getOrCreateConversation(this.platform, [
      memberId,
    ]);
    if (!conversation?.id) return undefined;

    return this.buildChatSummary(
      this.platform,
      conversation.id,
      fallbackName || conversation.name,
      conversation,
    );
  }

  private async resolveConversationForPersonName(
    query: string,
  ): Promise<RcChatSummary | undefined> {
    if (!this.platform || !this.botExtId) return undefined;

    const explicitPersonId = extractPersonIdFromRef(query);
    if (explicitPersonId) {
      return this.resolveConversationByMemberId(explicitPersonId);
    }

    const historyMatches = findChatParticipantsByName(query, {
      jidPrefix: this.jidPrefix,
      limit: 10,
    });
    for (const candidate of historyMatches) {
      const candidateId = candidate.sender?.trim();
      if (!candidateId || candidateId === this.botExtId) continue;

      const fromHistory = await this.resolveConversationByMemberId(
        candidateId,
        candidate.sender_name || candidateId,
      );
      if (fromHistory) return fromHistory;
    }

    const candidates = await searchDirectoryEntries(this.platform, query, 10);
    for (const candidate of candidates) {
      if (candidate.status && candidate.status !== 'Enabled') continue;
      const candidateId = candidate.id ? String(candidate.id) : undefined;
      if (!candidateId || candidateId === this.botExtId) continue;

      const fullName = [candidate.firstName, candidate.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      const fromDirectory = await this.resolveConversationByMemberId(
        candidateId,
        fullName || candidate.email || candidateId,
      );
      if (fromDirectory) return fromDirectory;
    }

    return undefined;
  }

  private async resolveOpaqueDirectChatsByMemberIds(
    memberNames: Map<string, string>,
    limit: number,
  ): Promise<RcChatSummary[]> {
    if (!this.platform || !this.botExtId || memberNames.size === 0) return [];

    const matches: RcChatSummary[] = [];
    const candidates = findChatsByPrefix(this.jidPrefix, 250).map((chat) => ({
      jid: chat.jid,
      chatId: this.normalizeChatId(chat.jid),
      name: chat.name || chat.jid,
    }));

    for (const candidate of candidates) {
      const detail = await getChat(this.platform, candidate.chatId);
      if (detail?.type?.toLowerCase() !== 'direct') continue;

      const otherMemberIds = (detail.members ?? [])
        .map((member) => member.id?.trim())
        .filter(
          (memberId): memberId is string =>
            !!memberId && memberId !== this.botExtId,
        );

      const matchedMemberId = otherMemberIds.find((memberId) =>
        memberNames.has(memberId),
      );
      if (!matchedMemberId) continue;

      const hydrated = await this.buildChatSummary(
        this.platform,
        candidate.chatId,
        memberNames.get(matchedMemberId) ?? candidate.name,
        detail,
      );
      matches.push(hydrated);
      if (matches.length >= limit) break;
    }

    return matches;
  }

  private async searchOpaqueCachedChats(
    query: string,
    limit: number,
  ): Promise<RcChatSummary[]> {
    if (!this.platform) return [];

    const matches: RcChatSummary[] = [];
    const candidates = this.findOpaqueCachedChats(
      Math.min(Math.max(limit * 4, 20), 50),
    );

    for (const candidate of candidates) {
      const detail = await getChat(this.platform, candidate.chatId);
      const hydrated = await this.buildChatSummary(
        this.platform,
        candidate.chatId,
        candidate.name,
        detail,
      );
      if (!matchesQuery(query, [hydrated.chatId, hydrated.name])) continue;
      matches.push(hydrated);
      if (matches.length >= limit) break;
    }

    return matches;
  }

  private async resolveMessageHistoryDirectChats(
    query: string,
    limit: number,
  ): Promise<RcChatSummary[]> {
    if (!this.platform || !this.botExtId) return [];

    const candidates = findChatParticipantsByName(query, {
      jidPrefix: this.jidPrefix,
      limit: Math.min(Math.max(limit * 3, 10), 25),
    });
    const candidateNames = new Map<string, string>();
    for (const candidate of candidates) {
      const candidateId = candidate.sender?.trim();
      if (!candidateId || candidateId === this.botExtId) continue;
      candidateNames.set(candidateId, candidate.sender_name || candidateId);
    }

    return this.resolveOpaqueDirectChatsByMemberIds(candidateNames, limit);
  }

  private async resolveDirectChatIdLookup(
    query: string,
  ): Promise<RcChatSummary | null> {
    if (!this.platform || !this.looksLikeChatId(query)) return null;

    const chatId = this.normalizeChatId(query.trim());
    const cachedChat = this.findCachedChats(chatId, 1)[0];
    const chat = await getChat(this.platform, chatId);
    if (!chat?.id) return null;

    return this.buildChatSummary(
      this.platform,
      chat.id,
      cachedChat?.name ?? chat.name,
      chat,
    );
  }

  async listChatsForAgent(
    query?: string,
    limit = 50,
  ): Promise<RcChatSummary[]> {
    if (!this.platform) throw new Error('RC channel is not connected');

    const cappedLimit = Math.min(Math.max(limit, 1), 250);
    const trimmedQuery = query?.trim();
    if (trimmedQuery) {
      if (this.looksLikeChatId(trimmedQuery)) {
        const directIdMatch =
          await this.resolveDirectChatIdLookup(trimmedQuery);
        if (directIdMatch) {
          return [directIdMatch];
        }
      }

      const messageHistoryMatches = await this.resolveMessageHistoryDirectChats(
        trimmedQuery,
        cappedLimit,
      );
      if (messageHistoryMatches.length > 0) {
        return messageHistoryMatches;
      }

      const cachedChats = this.findCachedChats(trimmedQuery, cappedLimit);
      if (cachedChats.length > 0) {
        return cachedChats.slice(0, cappedLimit);
      }

      const opaqueMatches = await this.searchOpaqueCachedChats(
        trimmedQuery,
        cappedLimit,
      );
      if (opaqueMatches.length > 0) {
        return opaqueMatches;
      }

      const directoryMatches = await this.resolveDirectoryBackedDirectChats(
        trimmedQuery,
        cappedLimit,
      );
      if (directoryMatches.length > 0) {
        return directoryMatches;
      }
    }

    const chats = await listChats(this.platform, {
      limit: cappedLimit,
      query,
    });
    const teams = await listTeams(this.platform, {
      limit: cappedLimit,
      query,
    });
    const allChats = mergeChatListItems(chats, teams);
    const normalizedQuery = query?.trim().toLowerCase();
    const summaries: RcChatSummary[] = [];

    for (const chat of allChats) {
      if (!chat.id) continue;
      const summary = await this.buildChatSummary(
        this.platform,
        chat.id,
        chat.name,
        chat,
      );
      if (
        normalizedQuery &&
        !matchesQuery(query, [summary.chatId, summary.name])
      ) {
        continue;
      }
      summaries.push(summary);
      if (summaries.length >= cappedLimit) {
        return summaries;
      }
    }

    return summaries;
  }

  private async resolveKnownChatForAgent(
    chatRef: string,
  ): Promise<RcChatSummary | undefined> {
    const trimmedRef = chatRef.trim();
    if (!trimmedRef) return undefined;

    if (this.looksLikeChatId(trimmedRef)) {
      return (await this.resolveDirectChatIdLookup(trimmedRef)) ?? undefined;
    }

    return (
      this.findCachedChats(trimmedRef, 1)[0] ??
      (await this.searchOpaqueCachedChats(trimmedRef, 1))[0] ??
      (await this.resolveMessageHistoryDirectChats(trimmedRef, 1))[0] ??
      (await this.resolveDirectoryBackedDirectChats(trimmedRef, 1))[0]
    );
  }

  async readMessagesForAgent(
    chatRef: string,
    limit = 20,
  ): Promise<RcChatTranscript> {
    if (!this.platform) throw new Error('RC channel is not connected');

    const cachedChat =
      (await this.resolveKnownChatForAgent(chatRef)) ??
      (!this.looksLikeChatId(chatRef)
        ? (await this.listChatsForAgent(chatRef, 1))[0]
        : undefined);
    const chatId = this.normalizeChatId(cachedChat?.jid ?? chatRef);
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    try {
      return await this.readTranscriptFromPlatform(
        await this.refreshPlatform(),
        chatId,
        cappedLimit,
        cachedChat,
      );
    } catch (err) {
      if (!shouldRetryRcRead(err)) {
        throw err;
      }

      logger.warn(
        { chatId, err },
        'RC read failed on fresh platform, retrying once more with fresh auth',
      );
      const refreshedPlatform = await this.refreshPlatform();
      return this.readTranscriptFromPlatform(
        refreshedPlatform,
        chatId,
        cappedLimit,
        cachedChat,
      );
    }
  }

  async sendMessageForAgent(
    chatRef: string,
    text: string,
  ): Promise<{ jid: string; chatId: string; postId?: string }> {
    if (!this.platform) throw new Error('RC channel is not connected');

    const explicitPersonId = extractPersonIdFromRef(chatRef);
    let resolvedChat = explicitPersonId
      ? await this.resolveConversationByMemberId(explicitPersonId)
      : ((await this.resolveKnownChatForAgent(chatRef)) ??
        (!this.looksLikeChatId(chatRef)
          ? (await this.listChatsForAgent(chatRef, 1))[0]
          : undefined));
    if (!resolvedChat && !this.looksLikeChatId(chatRef)) {
      throw new Error(`Unable to resolve RC chat: ${chatRef}`);
    }

    let chatId = this.normalizeChatId(resolvedChat?.jid ?? chatRef);
    let sendContext = await this.getSendPlatform(chatId);
    let postId: string | undefined;

    try {
      postId = await sendPost(sendContext.platform, chatId, text);
    } catch (err) {
      if (this.looksLikeChatId(chatRef) || !isRcNotFound(err)) {
        throw err;
      }

      const freshConversation =
        await this.resolveConversationForPersonName(chatRef);
      if (!freshConversation) throw err;

      resolvedChat = freshConversation;
      chatId = this.normalizeChatId(freshConversation.jid);
      sendContext = await this.getSendPlatform(chatId);
      postId = await sendPost(sendContext.platform, chatId, text);
    }

    if (postId) {
      this.trackSent(postId);
      const creatorId = await verifySentPostCreator(
        sendContext.platform,
        chatId,
        postId,
      );
      if (
        sendContext.expectedCreatorId &&
        creatorId &&
        creatorId !== sendContext.expectedCreatorId
      ) {
        throw new Error(
          `Bot-auth send resolved to creator ${creatorId}, expected ${sendContext.expectedCreatorId}${sendContext.ownerId ? ` (ownerId=${sendContext.ownerId})` : ''}`,
        );
      }
      logger.info(
        {
          jid: this.jidForChatId(chatId),
          postId,
          creatorId,
          connectedExtId: this.botExtId,
          ownerId: sendContext.ownerId,
        },
        'RC sent post verification',
      );
    }

    logger.info(
      { jid: this.jidForChatId(chatId), length: text.length },
      'RC SDK message sent',
    );

    return {
      jid: this.jidForChatId(chatId),
      chatId,
      postId,
    };
  }

  async listChatMembersForAgent(
    chatRef: string,
    limit = 100,
  ): Promise<RcChatMember[]> {
    if (!this.platform) throw new Error('RC channel is not connected');

    const chatId = this.normalizeChatId(chatRef);
    const cappedLimit = Math.min(Math.max(limit, 1), 250);
    return listChatMembers(this.platform, chatId, cappedLimit);
  }

  async getPresenceForAgent(extensionId?: string): Promise<RcPresence> {
    if (!this.platform) throw new Error('RC channel is not connected');
    return getPresence(this.platform, extensionId || '~');
  }

  async setPresenceForAgent(
    update: RcPresenceUpdateInput,
  ): Promise<RcPresence> {
    if (!this.platform) throw new Error('RC channel is not connected');
    return setPresence(this.platform, update);
  }

  async getExtensionForAgent(
    extensionId?: string,
  ): Promise<RcExtensionSummary> {
    if (!this.platform) throw new Error('RC channel is not connected');
    return getExtension(this.platform, extensionId || '~');
  }

  async listExtensionsForAgent(
    query?: string,
    limit = 50,
  ): Promise<RcExtensionSummary[]> {
    if (!this.platform) throw new Error('RC channel is not connected');

    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    const extensions = await listExtensions(
      this.platform,
      Math.min(cappedLimit * 3, 100),
    );

    return extensions
      .filter((extension) =>
        matchesQuery(query, [
          extension.id ? String(extension.id) : undefined,
          extension.extensionNumber,
          extension.name,
          extension.email,
          extension.contact?.firstName,
          extension.contact?.lastName,
          extension.contact?.email,
        ]),
      )
      .slice(0, cappedLimit);
  }

  async listContactsForAgent(query?: string, limit = 50): Promise<RcContact[]> {
    if (!this.platform) throw new Error('RC channel is not connected');

    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    const contacts = await listContacts(
      this.platform,
      Math.min(cappedLimit * 3, 100),
    );

    return contacts
      .filter((contact) =>
        matchesQuery(query, [
          contact.id,
          contact.firstName,
          contact.lastName,
          contact.email,
          contact.company,
          contact.jobTitle,
        ]),
      )
      .slice(0, cappedLimit);
  }

  async createContactForAgent(contact: RcContactInput): Promise<RcContact> {
    if (!this.platform) throw new Error('RC channel is not connected');
    return createContact(this.platform, contact);
  }

  async listPhoneNumbersForAgent(limit = 50): Promise<RcPhoneNumber[]> {
    if (!this.platform) throw new Error('RC channel is not connected');

    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    return listPhoneNumbers(this.platform, cappedLimit);
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
    const ownerIdValue =
      (event as { ownerId?: string | number })?.ownerId ??
      (body.ownerId as string | number | undefined);
    const timestamp = body.creationTime
      ? new Date(body.creationTime as string).toISOString()
      : new Date().toISOString();

    if (!chatId) return;
    if (ownerIdValue !== undefined && ownerIdValue !== null) {
      this.lastOwnerIdByChat.set(chatId, String(ownerIdValue));
    }
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
          chatJid: jid,
          value: enable,
        });
        return; // do not store or route this message
      }

      const serviceMatch = text.match(
        /^\s*(enable|disable|turn\s+on|turn\s+off)\s+(service|nanoclaw)\s*$/i,
      );
      const ownerControlGroup = this.opts.registeredGroups()[jid];
      if (serviceMatch && ownerControlGroup?.folder === 'rc-personal') {
        const enable = /enable|turn\s+on/i.test(serviceMatch[1]);
        await this.opts.onOwnerCommand({
          action: 'set_service_enabled',
          chatJid: jid,
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
          // Ignore unknown RC chats unless the bot is explicitly @mentioned.
          // Auto-replying here is too risky because unregistered team chats can
          // surface without a bot mention, which would spam the conversation.
          logger.info(
            { jid, chatId },
            'Ignoring unknown RC chat without mention',
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
      const chats = await listChats(this.platform, {
        limit: 250,
        suppressErrors: true,
      });
      let count = 0;
      for (const chat of chats) {
        if (chat.id && chat.name) {
          updateChatName(`${this.jidPrefix}${chat.id}`, chat.name);
          count++;
        }
      }
      const teams = await listTeams(this.platform, {
        limit: 250,
        suppressErrors: true,
      });
      for (const team of teams) {
        if (team.id && team.name) {
          updateChatName(`${this.jidPrefix}${team.id}`, team.name);
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
    globalSentPostIds.set(postId, now + SENT_TTL);
    for (const [id, exp] of this.sentIds) {
      if (now > exp) this.sentIds.delete(id);
    }
    for (const [id, exp] of globalSentPostIds) {
      if (now > exp) globalSentPostIds.delete(id);
    }
  }

  private isOwn(postId: string): boolean {
    const globalExp = globalSentPostIds.get(postId);
    if (globalExp !== undefined) {
      if (Date.now() > globalExp) {
        globalSentPostIds.delete(postId);
      } else {
        return true;
      }
    }

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

  private async resolveUser(
    userId: string,
    platformOverride?: RCPlatform,
  ): Promise<string | undefined> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;
    const platform = platformOverride ?? this.platform;
    if (!platform) return undefined;
    const user = await fetchUser(platform, userId);
    const name =
      [user?.firstName, user?.lastName].filter(Boolean).join(' ') ||
      user?.email;
    if (name) this.userCache.set(userId, name);
    return name;
  }

  private async readTranscriptFromPlatform(
    platform: RCPlatform,
    chatId: string,
    limit: number,
    cachedChat?: RcChatSummary,
  ): Promise<RcChatTranscript> {
    this.platform = platform;
    const chat = await getChat(platform, chatId);
    const team = chat?.name ? null : await getTeam(platform, chatId);
    const posts = await listPosts(platform, chatId, limit);

    const messages = await Promise.all(
      posts.map(async (post) => {
        const creatorId = post.creatorId ?? '';
        const creatorName =
          creatorId && creatorId === this.botExtId
            ? ASSISTANT_NAME
            : ((creatorId
                ? await this.resolveUser(creatorId, platform)
                : undefined) ??
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
      name:
        (await this.resolveChatDisplayName(
          platform,
          chatId,
          cachedChat?.name ?? chat?.name ?? team?.name,
          chat,
        )) ?? this.jidForChatId(chatId),
      messages: messages.reverse(),
    };
  }

  private async refreshPlatform(): Promise<RCPlatform> {
    const { platform } = await createAuthenticatedSdk(this.creds);
    return platform;
  }

  private async getSendPlatform(chatId: string): Promise<{
    platform: RCPlatform;
    expectedCreatorId?: string;
    ownerId?: string;
  }> {
    if (!this.creds.botToken) {
      if (!this.platform) throw new Error('RC channel is not connected');
      return {
        platform: this.platform,
        expectedCreatorId: this.botExtId,
      };
    }

    const ownerId = this.lastOwnerIdByChat.get(chatId);
    const ownerScopedToken =
      ownerId && this.creds.botTokensByOwnerId
        ? this.creds.botTokensByOwnerId[ownerId]
        : undefined;
    const sendCreds =
      ownerScopedToken && ownerScopedToken !== this.creds.botToken
        ? {
            ...this.creds,
            botToken: ownerScopedToken,
          }
        : this.creds;

    return {
      platform: await createAuthenticatedSdk(sendCreds).then(
        ({ platform }) => platform,
      ),
      expectedCreatorId: this.botExtId,
      ownerId,
    };
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
          const {
            platform: sendPlatform,
            expectedCreatorId,
            ownerId,
          } = await this.getSendPlatform(chatId);
          const postId = await sendPost(sendPlatform, chatId, item.text);
          if (postId) {
            this.trackSent(postId);
            const creatorId = await verifySentPostCreator(
              sendPlatform,
              chatId,
              postId,
            );
            if (
              expectedCreatorId &&
              creatorId &&
              creatorId !== expectedCreatorId
            ) {
              throw new Error(
                `Bot-auth send resolved to creator ${creatorId}, expected ${expectedCreatorId}${ownerId ? ` (ownerId=${ownerId})` : ''}`,
              );
            }
            logger.info(
              {
                jid: item.jid,
                postId,
                creatorId,
                connectedExtId: this.botExtId,
                ownerId,
              },
              'RC sent post verification',
            );
          }
        }
        logger.info({ jid: item.jid }, 'Queued RC message sent');
      }
    } finally {
      this.flushing = false;
    }
  }
}
