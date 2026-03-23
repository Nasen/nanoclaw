# NanoClaw Architecture

> **Audience:** AI coding agents (Claude, Codex, Gemini) contributing to this repo.
> Read this before making changes to understand how the subsystems relate.

---

## Overview

NanoClaw is a **host-side TypeScript service** that bridges messaging channels (WhatsApp, Slack, RingCentral) to AI coding agents running inside isolated Docker containers. It receives chat messages, decides when to route them to an AI agent, runs the agent in a container, and delivers the agent's reply back to the chat.

```
Messaging Channels
  (WhatsApp / Slack / RingCentral)
         │  inbound messages
         ▼
  ┌─────────────┐
  │  src/index  │  ← entry point: wires everything together
  └──────┬──────┘
         │
   ┌─────┴──────────────────────────────────────────┐
   │                  Host Runtime                   │
   │  message-loop ──► group-queue ──► container-runner │
   │  ipc-watcher                                    │
   │  credential-proxy                               │
   └─────────────────────────────────────────────────┘
         │  Docker exec / stdin
         ▼
  ┌──────────────────────────┐
  │  container/agent-runner  │  ← runs INSIDE the Docker container
  │  providers/claude.ts     │
  │  providers/openai.ts     │
  │  ipc-mcp-stdio.ts        │
  └──────────────────────────┘
         │  text reply
         ▼
Messaging Channels (outbound)
```

---

## Directory Map

| Path | Purpose |
|---|---|
| `src/` | Host app: channels, orchestration, DB, IPC watcher |
| `src/channels/` | Channel adapters (WhatsApp, Slack, RingCentral) |
| `container/agent-runner/src/` | Agent logic that runs inside Docker |
| `container/agent-runner/src/providers/` | Claude & OpenAI provider implementations |
| `setup/` | One-time setup: env checks, service registration, container verification |
| `data/` | Runtime state: SQLite DB, IPC dirs, session files |
| `data/ipc/` | File-based IPC: agent→host message/task drops |
| `groups/` | Per-group config folders (one subdirectory per registered group) |
| `logs/` | Service logs (`nanoclaw.log`) |
| `skills-engine/` | Skill parsing and execution engine |

---

## Startup Sequence (`src/index.ts` → `main()`)

1. **Container runtime check** — `ensureContainerRuntimeRunning()` verifies Docker is up; `cleanupOrphans()` kills any leftover containers from the previous run.
2. **Database init** — `initDatabase()` opens the SQLite database in `data/`.
3. **State load** — Reads `last_timestamp`, per-group agent cursors, session IDs, and registered groups from the DB.
4. **Credential proxy** — `startCredentialProxy()` binds an HTTP proxy on `CREDENTIAL_PROXY_PORT`. Containers send all AI API calls through this proxy; it injects real API keys/tokens so containers never hold credentials.
5. **Channel connect** — `connectInstalledChannels()` and `connectRingCentralChannels()` instantiate and connect all configured channel adapters.
6. **Subsystems start** (`orchestrator-runtime.ts`):
   - **Message loop** — polling loop that checks for new DB messages.
   - **IPC watcher** — polling loop that scans `data/ipc/` for agent→host file drops.
   - **RC auto-register** — if RingCentral is enabled, watches for new DM/group events.
   - **Task scheduler** — fires cron/interval/once scheduled tasks for registered groups.
   - **Remote control** — optional Claude remote-control session manager.

---

## Core Data Flow

### Inbound Message Routing

```
Channel adapter (e.g., WhatsApp)
  └─► onMessage() callback
         └─► storeMessage() → SQLite messages table
                └─► message-loop (polling, POLL_INTERVAL ms)
                       └─► getNewMessages() from DB
                              └─► groupMessagesByChat()
                                     └─► shouldSkipGroupMessages()
                                            (trigger check, sender allowlist)
                                     └─► pipeOrEnqueueMessages()
                                            ├─ if container running: send via stdin (GroupQueue)
                                            └─ else: enqueueMessageCheck(chatJid) → GroupQueue
```

### Agent Invocation

```
GroupQueue.dequeue(chatJid)
  └─► processGroupMessages() (group-agent-runner.ts)
         ├─ getMessagesSince(lastAgentTimestamp)
         ├─ format prompt
         ├─ writeTasksSnapshot() + writeGroupsSnapshot() → /workspace/ JSON files
         └─► runContainerAgent() (container-runner.ts)
                └─► docker run nanoclaw-agent-v3
                       └─► container/agent-runner/src/index.ts
                              └─► provider (claude.ts | openai.ts)
                                     └─► streams output chunks back to host
```

### Agent Output → Channel Reply

```
container-runner output callback
  └─► strip <internal>…</internal> tags
  └─► resolveOutboundTarget() (router.ts)
         └─► channel.sendMessage(jid, text)
```

---

## Key Modules

### `src/message-loop.ts`
The main polling loop. Every `POLL_INTERVAL` ms it calls `processPollingCycle()`:
- Fetches all messages newer than `lastTimestamp` for registered group JIDs.
- Groups messages by chat JID.
- Checks trigger words and sender allowlist.
- Either pipes directly to the active container's stdin (if the container is running) or enqueues a check via `GroupQueue`.

### `src/group-queue.ts`
Serializes agent runs per chat group. Ensures only one container runs at a time per group. Accepts `enqueueMessageCheck(chatJid)` calls; drains the queue by calling `processGroupMessages` sequentially.

### `src/group-agent-runner.ts`
Orchestrates one complete agent turn:
1. Optionally prepends auto-assist or RingCentral routing prefixes to the prompt.
2. Writes task/group snapshots so the agent can discover what groups/tasks exist.
3. Calls `runContainerAgent()` and streams results back.
4. On error with no output sent, rolls back `lastAgentTimestamp` so the turn is retried.

### `src/container-runner.ts`
Runs the Docker container. Passes configuration as environment variables, mounts the group workspace at `/workspace`, and manages the container lifecycle (start, stream stdout, kill on timeout).

### `src/credential-proxy.ts`
Transparent HTTP proxy listening on `127.0.0.1:CREDENTIAL_PROXY_PORT`. Injects API keys/OAuth tokens on every request so containers only need a placeholder. Supports both `api-key` and `oauth` auth modes, and both Claude and OpenAI backends.

### `src/ipc.ts` + `src/ipc-message-handler.ts` + `src/ipc-task-handler.ts`
File-based IPC. The agent running inside the container writes JSON files to `/workspace/ipc/messages/` or `/workspace/ipc/tasks/`. The host IPC watcher (`startIpcWatcher`) polls `data/ipc/` and processes them:
- **Messages**: agent sends a message to a chat JID.
- **Tasks**: agent creates/updates/deletes scheduled tasks.

### `src/ipc.ts` IPC directory layout
```
data/ipc/
  {groupFolder}/
    messages/   ← agent drops {uuid}.json files here
    tasks/      ← agent drops task mutation JSON files here
  errors/       ← failed IPC files moved here for inspection
```

### `src/remote-control.ts`
Spawns `claude remote-control` as a detached child process and polls its stdout file (every `URL_POLL_MS = 200ms`) until the Claude.ai session URL appears or a 30-second timeout. Saves session state to `data/remote-control.json` so it survives host restarts.

### `src/db.ts`
SQLite (via `better-sqlite3`) single-file database in `data/`. Key tables:
- `messages` — all inbound messages, indexed by JID and timestamp.
- `chats` — discovered chats and their last-activity metadata.
- `registered_groups` — groups the agent is activated for.
- `sessions` — persisted Claude/OpenAI session IDs per group folder.
- `scheduled_tasks` + `task_run_logs` — cron/interval task definitions and history.
- `router_state` — arbitrary key/value pairs for persistent host state.

---

## Channel System (`src/channels/`)

All channels implement the `Channel` interface from `src/types.ts`:

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

Channels self-register via `registerChannel()` in `src/channels/registry.ts`. Each file imports `registerChannel` and calls it at module load time.

| Channel | JID format | Notes |
|---|---|---|
| WhatsApp | `{phone}@s.whatsapp.net` / `{id}@g.us` | Baileys library; LID→phone translation built-in |
| Slack | (workspace-specific) | Event-based via Bolt |
| RingCentral | `rc:{chatId}` / `rcb:{chatId}` | Supports `personal`/`bot` delivery modes |

---

## Container Agent (`container/agent-runner/`)

A separate Node.js package that runs **inside** Docker. Entry point: `src/index.ts`.

- Reads the prompt and config from environment variables passed by the host.
- Selects provider (`claude` or `openai`) at runtime.
- `providers/claude.ts` — wraps Claude Code CLI or the Claude SDK, streams tool use and text output.
- `providers/openai.ts` — wraps OpenAI Responses API with MCP tool integration.
- `ipc-mcp-stdio.ts` — exposes an MCP server over stdio so the agent can call host-side tools (e.g., `send_message`, `register_group`, `list_chats`).

The agent communicates results back to the host by writing to stdout (captured by `container-runner.ts`).

---

## Security Model

- **Credential isolation**: Containers never hold real API keys. All AI API traffic is proxied through the host credential proxy.
- **Mount allowlist**: `~/.config/nanoclaw/mount-allowlist.json` controls which host directories can be bind-mounted into containers. This file is NOT mounted into containers (tamper-proof).
- **Sender allowlist**: `sender-allowlist.ts` can restrict which chat JIDs or senders can trigger the agent.
- **Non-main groups**: By default, additional group mounts are read-only (`nonMainReadOnly: true`).

---

## Adding a New Channel

1. Create `src/channels/{name}.ts`.
2. Implement the `Channel` interface.
3. Call `registerChannel('{name}', (opts) => new YourChannel(opts))` at the bottom.
4. Import the file in `src/channels/index.ts` (side-effect import).
5. Add any environment variables to `src/config.ts` and `.env.example`.
6. Update `connectInstalledChannels()` in `src/channel-bootstrap.ts` if conditional logic is needed.

## Adding a New Agent Provider

1. Create `container/agent-runner/src/providers/{name}.ts`.
2. Export a `run(config)` function that streams output chunks to the host callback.
3. Re-export / register it in `container/agent-runner/src/providers/index.ts`.
4. Add a branch in `container/agent-runner/src/index.ts` to select it based on the `AGENT_BACKEND` env var.
5. Add any credential-proxy auth mode support in `src/credential-proxy.ts` if needed.

---

## Environment Variables (Key Ones)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | Claude credentials (injected by proxy) |
| `OPENAI_API_KEY` | OpenAI credentials (injected by proxy) |
| `AGENT_BACKEND` | `claude` (default) or `openai` |
| `ASSISTANT_NAME` | Bot trigger name (e.g. `@nanoclaw`) |
| `CREDENTIAL_PROXY_PORT` | Port for the credential proxy (default: 9999) |
| `POLL_INTERVAL` | DB polling interval in ms (default: 1000) |
| `IDLE_TIMEOUT` | Agent idle timeout in ms before stdin closes |
| `CONTAINER_IMAGE` | Docker image tag to run agents in |
| `TIMEZONE` | Timezone for message formatting |

See `.env.example` for the full list.
