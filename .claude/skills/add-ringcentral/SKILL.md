---
name: add-ringcentral
description: Add RingCentral Team Messaging as a NanoClaw channel. Supports a JWT-backed owner channel (`rc:`) and an optional bot-token auto-register channel (`rcb:`) for team chats.
---

# Add RingCentral Channel

This skill packages the RingCentral support from this fork into a contributor-style NanoClaw skill.

## Phase 1: Pre-flight

### Check if already applied

If `src/channels/ringcentral.ts` already exists, the code is already present. Skip to Phase 3.

### Decide channel mode

There are two supported modes:

- `rc:` owner channel via `RC_CLIENT_ID` + `RC_CLIENT_SECRET` + `RC_JWT`
- `rcb:` bot add-in channel via `RC_BOT_CLIENT_ID` + `RC_BOT_CLIENT_SECRET` + `RC_BOT_TOKEN`

The owner channel is enough for a personal main chat. The bot add-in channel is optional and adds auto-registration for team chats when the bot is @mentioned.

## Phase 2: Apply Code Changes

This fork includes a structured skill package. Apply it with:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-ringcentral
```

This skill adds:
- `src/channels/ringcentral.ts`
- `src/rc-auto-register.ts`

It modifies:
- `src/index.ts`
- `src/channel-bootstrap.ts`
- `src/container-config.ts`
- `src/group-agent-runner.ts`
- `src/message-gating.ts`

Then install dependencies if needed:

```bash
npm install
```

### Validate code changes

There is no dedicated RingCentral runtime test yet. Validate with:

```bash
npm run typecheck
npm run build
npx vitest run .claude/skills/add-ringcentral/tests/ringcentral.test.ts
```

## Phase 3: Configure Credentials

Add the needed RingCentral credentials to `.env`.

Owner channel:

```bash
RC_CLIENT_ID=...
RC_CLIENT_SECRET=...
RC_JWT=...
RC_SERVER=https://platform.ringcentral.com
```

Optional bot add-in channel:

```bash
RC_BOT_CLIENT_ID=...
RC_BOT_CLIENT_SECRET=...
RC_BOT_TOKEN=...
```

Sync environment for containers:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 4: Register Main RingCentral Chat

Start the service, send at least one message in the RingCentral chat you want to use as the owner channel, then inspect discovered chats:

```bash
sqlite3 store/messages.db "select jid, name from chats where jid like 'rc:%' order by last_message_time desc limit 20;"
```

Register your main personal chat using the `rc:` JID:

```bash
npx tsx setup/index.ts --step register -- \
  --jid "rc:<chat-id>" \
  --name "RingCentral Personal" \
  --folder "rc-personal" \
  --trigger "@Andy" \
  --channel ringcentral \
  --no-trigger-required \
  --is-main
```

If you want owner DMs treated as full personal context, create `groups/direct-contacts.json`:

```json
{
  "enabled": true,
  "mainFolders": ["rc-personal"],
  "personalFolders": []
}
```

## Phase 5: Enable Team Chat Auto-Registration

This is only needed if you configured the bot add-in credentials.

The `rcb:` channel auto-registers unknown team chats on first bot @mention. No manual chat registration is needed for those chats.

Requirements:
- the bot add-in channel is connected
- `groups/direct-contacts.json` exists with `"enabled": true`
- users @mention the bot in a team chat

The first mention creates a folder like `groups/rc-grp-<chatId>/`.

## Phase 6: Verify

### Owner channel

Send a message in your registered owner chat. The assistant should reply without requiring the trigger because the group is registered as main.

### Bot add-in team chat

Mention the bot in a RingCentral team chat. The skill should auto-register the team chat and reply only when directly @mentioned.

### Check logs

```bash
tail -f logs/nanoclaw.log
```

## Notes

- RingCentral Team Messaging has no typing indicator API
- oversized outbound messages are split into 4000-character chunks
- the JWT owner channel and the bot-token channel are intentionally separate
- owner-channel auto-assist toggles are handled through RingCentral owner commands in the channel bootstrap path
