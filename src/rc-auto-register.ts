/**
 * RC Group Chat Auto-Registration
 *
 * Auto-registers unknown RC group/team chats when the bot is @mentioned.
 * Unknown chats without a bot @mention are ignored so NanoClaw never posts
 * unsolicited rejection messages into team conversations.
 *
 * Folder: rc-grp-{chatId}  (stable regardless of who @mentions)
 * requiresTrigger: true    (only @Bob mentions trigger a response)
 *
 * Nasen's own DM (rc-personal) is pre-registered and never hits this path.
 *
 * Toggle with groups/direct-contacts.json: { "enabled": false }
 */

import fs from 'fs';
import path from 'path';

import { setRegisteredGroup } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// ─── Config ───────────────────────────────────────────────────────────────────

interface DirectContactsConfig {
  enabled: boolean;
  /** Folders treated as isMain: full infrastructure privileges (project root mount,
   *  full IPC visibility, all tasks). Implies personalMode. */
  mainFolders?: string[];
  /** Folders treated as personalMode only: full MCP tools + read-write mounts,
   *  but not isMain infrastructure privileges. */
  personalFolders?: string[];
}

function loadConfig(groupsDir: string): DirectContactsConfig | null {
  const configPath = path.join(groupsDir, 'direct-contacts.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as DirectContactsConfig;
  } catch {
    return null;
  }
}

function isEnabled(groupsDir: string): boolean {
  return loadConfig(groupsDir)?.enabled === true;
}

/**
 * Returns true if the folder should be treated as isMain
 * (project root mount, full IPC + task visibility, NANOCLAW_IS_MAIN=1).
 * Reads mainFolders from groups/direct-contacts.json.
 */
export function isMainFolder(folder: string, groupsDir: string): boolean {
  const config = loadConfig(groupsDir);
  return config?.mainFolders?.includes(folder) ?? false;
}

/**
 * Returns true if the folder should be treated as personalMode
 * (full MCP tools + read-write mounts). mainFolders implicitly qualify too.
 * Reads personalFolders from groups/direct-contacts.json.
 */
export function isPersonalFolder(folder: string, groupsDir: string): boolean {
  const config = loadConfig(groupsDir);
  return (
    (config?.mainFolders?.includes(folder) ?? false) ||
    (config?.personalFolders?.includes(folder) ?? false)
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildGroupClaudeMd(): string {
  return `# Bob — Nasen's Representative (Group Chat)

You are Bob, acting as Nasen You when @mentioned in a RingCentral team or group chat.

Only respond when directly @mentioned. Be concise — you are speaking in a group,
so keep replies focused and professional.

## Personal Context

Load from /workspace/global/personal/ at the start of every session:
- identity.md — Who Nasen is
- voice.md — How Nasen communicates
- contacts.md — Key relationships
- preferences.md — Nasen's decision patterns

Use this knowledge to inform your responses. Do not quote these files verbatim.

## Org Database

Full RC org at /workspace/global/org.db — query with Python3 when needed:

\`\`\`bash
python3 - << 'EOF'
import sqlite3
con = sqlite3.connect('/workspace/global/org.db')
con.row_factory = sqlite3.Row
rows = con.execute("SELECT full_name, title, direct_manager, team_name FROM employees WHERE full_name LIKE '%Name%'").fetchall()
for r in rows: print(dict(r))
EOF
\`\`\`

## Core Behavior

You ARE Nasen — write as him, make decisions as he would.

Respond to the person who @mentioned you, matching Nasen's voice and relationship
to that person. Check contacts.md and preferences.md before responding.

For high-stakes decisions (headcount, budget, commitments):
"Let me check on that and get back to you."

## Communication Format

RingCentral Team Messaging — plain text only:
- Bullet points (•) are fine
- No markdown headings or bold/italic
- Keep replies short and on-point for a group setting

Wrap internal reasoning in \`<internal>\` tags — not sent to the user.
`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Auto-register an unknown RC group/team chat on first @mention.
 * Only team chats with an explicit bot @mention are auto-registered.
 * Unknown chats without a mention are ignored by the caller.
 *
 * @param jid             Full JID (e.g. rcb:12345)
 * @param senderName      Resolved display name of the message sender
 * @param chatId          Raw RC chat ID (numeric string) — used for stable folder naming
 * @param isGroupMention  True when the message contains a bot @mention (group chat)
 * @param groupsDir       Absolute path to the groups/ directory
 *
 * @returns The RegisteredGroup if registration succeeded (caller should insert into
 *          the in-memory map), or null if disabled, a DM, or registration failed.
 */
export function autoRegisterContact(
  jid: string,
  senderName: string,
  chatId: string,
  isGroupMention: boolean,
  groupsDir: string,
): RegisteredGroup | null {
  // DMs to the bot extension are not supported. This bot is personal and should
  // only participate in team chats where Nasen is already present.
  if (!isGroupMention) return null;

  if (!isEnabled(groupsDir)) return null;

  const folder = `rc-grp-${chatId}`;
  const groupDir = path.join(groupsDir, folder);

  const group: RegisteredGroup = {
    name: `Group ${chatId}`,
    folder,
    trigger: '@Bob',
    added_at: new Date().toISOString(),
    requiresTrigger: true,
    isMain: false,
  };

  try {
    fs.mkdirSync(groupDir, { recursive: true });

    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      fs.writeFileSync(claudeMdPath, buildGroupClaudeMd(), 'utf-8');
    }

    setRegisteredGroup(jid, group);

    logger.info(
      { jid, senderName, folder, chatId },
      'RC group chat auto-registered',
    );
    return group;
  } catch (err) {
    logger.error(
      { jid, senderName, err },
      'Failed to auto-register RC group chat',
    );
    return null;
  }
}
