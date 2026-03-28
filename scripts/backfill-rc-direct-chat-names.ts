import Database from 'better-sqlite3';
import { SDK } from '@ringcentral/sdk';
import path from 'path';

import { readEnvFile } from '../src/env.js';

type RCPlatform = ReturnType<InstanceType<typeof SDK>['platform']>;

type ChatDetail = {
  id?: string;
  type?: string;
  members?: Array<{ id?: string }>;
  name?: string;
};

type PersonDetail = {
  firstName?: string;
  lastName?: string;
  email?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]): { jid?: string; limit?: number } {
  const result: { jid?: string; limit?: number } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--jid') result.jid = argv[i + 1];
    if (arg === '--limit') result.limit = Number(argv[i + 1] || 0) || undefined;
  }
  return result;
}

async function getChat(platform: RCPlatform, chatId: string): Promise<ChatDetail | null> {
  try {
    const resp = await platform.get(`/team-messaging/v1/chats/${chatId}`);
    return (await resp.json()) as ChatDetail;
  } catch {
    return null;
  }
}

async function getPerson(
  platform: RCPlatform,
  personId: string,
): Promise<PersonDetail | null> {
  try {
    const resp = await platform.get(`/team-messaging/v1/persons/${personId}`);
    return (await resp.json()) as PersonDetail;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = readEnvFile([
    'RC_CLIENT_ID',
    'RC_CLIENT_SECRET',
    'RC_JWT',
    'RC_SERVER',
  ]);

  const clientId = env.RC_CLIENT_ID;
  const clientSecret = env.RC_CLIENT_SECRET;
  const jwt = env.RC_JWT;
  const server = env.RC_SERVER || 'https://platform.ringcentral.com';

  if (!clientId || !clientSecret || !jwt) {
    throw new Error('Missing RC credentials in .env');
  }

  const sdk = new SDK({
    clientId,
    clientSecret,
    server,
  });
  const platform = sdk.platform();
  await platform.login({ jwt });

  const selfResp = await platform.get('/restapi/v1.0/account/~/extension/~');
  const selfBody = (await selfResp.json()) as { id?: string | number };
  const selfId = selfBody.id ? String(selfBody.id) : '';
  if (!selfId) throw new Error('Failed to resolve self RingCentral extension id');

  const db = new Database(path.join(process.cwd(), 'store', 'messages.db'));
  db.pragma('busy_timeout = 5000');

  const rows = (args.jid
    ? db
        .prepare(
          `
          SELECT jid
          FROM chats
          WHERE jid = ?
            AND jid LIKE 'rc:%'
            AND name = jid
        `,
        )
        .all(args.jid)
    : db
        .prepare(
          `
          SELECT jid
          FROM chats
          WHERE jid LIKE 'rc:%'
            AND name = jid
          ORDER BY last_message_time DESC
          LIMIT ?
        `,
        )
        .all(args.limit ?? 250)) as Array<{ jid: string }>;

  let updated = 0;
  let checked = 0;

  for (const row of rows) {
    checked += 1;
    const chatId = row.jid.slice(3);
    const chat = await getChat(platform, chatId);
    if (!chat || chat.type?.toLowerCase() !== 'direct') {
      await sleep(150);
      continue;
    }

    const otherMemberId = (chat.members ?? [])
      .map((member) => member.id ? String(member.id) : '')
      .find((memberId) => memberId && memberId !== selfId);
    if (!otherMemberId) {
      await sleep(150);
      continue;
    }

    const person = await getPerson(platform, otherMemberId);
    const name =
      [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim() ||
      person?.email ||
      '';
    if (!name) {
      await sleep(150);
      continue;
    }

    db.prepare(`UPDATE chats SET name = ? WHERE jid = ?`).run(name, row.jid);
    updated += 1;
    console.log(`${row.jid} -> ${name}`);
    await sleep(150);
  }

  console.log(`Checked ${checked} rows, updated ${updated}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
