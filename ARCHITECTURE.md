# NanoClaw Architecture

> Audience: AI coding agents and maintainers working on this customized NanoClaw fork.
> This document tracks the current local architecture, not just upstream NanoClaw concepts.

## Overview

NanoClaw is a host-side TypeScript service that accepts messages from connected channels, persists them in SQLite, decides whether a chat should trigger agent execution, and runs the agent inside an isolated container.

The host runtime is now intentionally split into smaller seams so local features can survive future merges from `upstream/main` with less conflict pressure.

```text
Messaging Channels
  (WhatsApp / Slack / RingCentral)
         |
         v
  app-controls.ts
    -> inbound gating
    -> service-control commands
    -> DB persistence
         |
         v
  app-processing.ts
    -> message-loop.ts
    -> group-agent-runner.ts
         |
         v
  group-queue.ts
    -> sticky per-chat container ownership
    -> idle eviction / lifecycle tracking
         |
         v
  container-runner.ts
    -> container-contract.ts
    -> container-config.ts
    -> container-timeout.ts
    -> container-snapshots.ts
         |
         v
  container/agent-runner/src/index.ts
    -> provider runtime
    -> MCP stdio bridge
    -> parked idle session loop
```

## Runtime Model

### Host process

The host remains a single Node.js process, but `src/index.ts` is now a composition root instead of owning all orchestration directly.

Current host seams:
- [src/index.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/index.ts): startup wiring and composition root
- [src/app-runtime-state.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/app-runtime-state.ts): persisted runtime state and registered-group state
- [src/app-controls.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/app-controls.ts): inbound message handling and service-control commands
- [src/app-processing.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/app-processing.ts): message-loop and per-chat processing adapters
- [src/orchestrator-runtime.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/orchestrator-runtime.ts): subsystem startup, RC host services, IPC dependency wiring, shutdown

### Container process

The container runner remains a separate Node package under `container/agent-runner/`.

Current container seams:
- [container/agent-runner/src/index.ts](/Users/nasen.you/Projects/GH/NanoClaw/container/agent-runner/src/index.ts): container-side turn loop
- [container/agent-runner/src/types.ts](/Users/nasen.you/Projects/GH/NanoClaw/container/agent-runner/src/types.ts): provider-facing runtime types
- [container/agent-runner/src/providers/](/Users/nasen.you/Projects/GH/NanoClaw/container/agent-runner/src/providers): backend adapters
- [container/agent-runner/src/ipc-mcp-stdio.ts](/Users/nasen.you/Projects/GH/NanoClaw/container/agent-runner/src/ipc-mcp-stdio.ts): host tool bridge over stdio

## Startup Sequence

1. [src/index.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/index.ts) verifies the container runtime and cleans up orphaned NanoClaw containers.
2. SQLite is initialized and [src/app-runtime-state.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/app-runtime-state.ts) loads:
   - registered groups
   - last poll timestamp
   - per-chat last-agent cursors
   - persisted session IDs
   - auto-assist and service-enabled flags
3. The credential proxy starts.
4. Installed channels connect.
5. [src/orchestrator-runtime.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/orchestrator-runtime.ts) starts:
   - message polling
   - IPC watcher
   - scheduler
   - RC host-side helper APIs
   - shutdown hooks

## Core Flows

### Inbound message flow

```text
Channel adapter
  -> buildChannelOpts() in app-controls.ts
  -> storeMessage() / storeChatMetadata()
  -> message-loop.ts polling cycle
  -> group-queue.ts
  -> group-agent-runner.ts
```

Notes:
- service-control commands are intercepted before normal message storage
- sender allowlist checks happen on inbound storage and again during trigger evaluation
- slash commands are routed before a normal prompt turn is sent

### Per-chat agent turn flow

```text
group-agent-runner.ts
  -> buildChatTurnInput() / slash-commands.ts
  -> group-turn-policy.ts
  -> writeTasksSnapshot() / writeGroupsSnapshot()
  -> runContainerAgent()
  -> relayGroupTurnResult()
```

Relevant seams:
- [src/group-agent-runner.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/group-agent-runner.ts): orchestration only
- [src/group-turn-policy.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/group-turn-policy.ts): prompt shaping, auto-assist behavior, outbound delivery policy
- [src/slash-commands.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/slash-commands.ts): `/reset` interception and raw slash forwarding rules

### Sticky session and parked-container flow

NanoClaw currently uses a one-chat-one-session model.

- each registered chat persists a session ID in SQLite
- the active container may stay parked in `idle_waiting` after a turn
- follow-up messages are piped to the parked container when possible
- oldest idle chat containers can be evicted when capacity is full
- a reset, eviction, process restart, or container failure may create a new container, but the chat session is resumed from persisted session state when possible

The main lifecycle logic spans:
- [src/group-queue.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/group-queue.ts)
- [src/group-agent-runner.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/group-agent-runner.ts)
- [src/container-runner.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/container-runner.ts)
- [container/agent-runner/src/index.ts](/Users/nasen.you/Projects/GH/NanoClaw/container/agent-runner/src/index.ts)

### IPC flow

The old monolithic IPC module has been split.

- [src/ipc.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/ipc.ts): thin barrel
- [src/ipc-watcher.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/ipc-watcher.ts): directory polling and dispatch
- [src/ipc-task-handler.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/ipc-task-handler.ts): task mutations and host actions
- [src/ipc-message-handler.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/ipc-message-handler.ts): outbound file-based message delivery
- [src/ipc-types.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/ipc-types.ts): watcher dependency surface

IPC directory layout:

```text
data/ipc/
  {groupFolder}/
    input/
    messages/
    tasks/
  errors/
```

## Container Boundary

The host/container contract is now split more explicitly:

- [src/container-contract.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/container-contract.ts): host-side protocol markers and container I/O types
- [src/container-config.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/container-config.ts): mount/env construction, personal-mode and main-folder inheritance, Git auth mounting
- [src/container-timeout.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/container-timeout.ts): timeout policy
- [src/container-snapshots.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/container-snapshots.ts): task/group snapshots written into IPC-visible files
- [src/container-runner.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/container-runner.ts): actual spawn, stream parsing, timeout handling, log capture

Important current behaviors:
- main folders inherit the extra mount profile from `rc-personal`
- owner-context containers may receive dedicated Git auth mounts
- `/workspace/project` stays read-only
- sticky containers are kept alive between turns until TTL, eviction, reset, restart, or failure

## Trust and Access Model

This fork currently distinguishes several practical trust levels in code:

- owner personal chat: `rc-personal`
- trusted admin/main folders: entries in `groups/direct-contacts.json -> mainFolders`
- normal registered groups
- blocked non-owner RC DMs

Not all of this is yet centralized behind one formal policy module. Some trust behavior still lives across:
- [src/group-access.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/group-access.ts)
- [src/message-gating.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/message-gating.ts)
- [src/service-control.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/service-control.ts)
- [src/channels/ringcentral.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/channels/ringcentral.ts)
- [src/container-config.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/container-config.ts)

That is the next major hardening seam if future work continues.

## Key Files

| File | Purpose |
|---|---|
| [src/index.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/index.ts) | Startup composition root |
| [src/app-runtime-state.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/app-runtime-state.ts) | Persisted runtime state and group registry |
| [src/app-controls.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/app-controls.ts) | Inbound channel callbacks and service control |
| [src/app-processing.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/app-processing.ts) | Message-loop/process-group adapters |
| [src/group-agent-runner.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/group-agent-runner.ts) | Per-chat turn orchestration |
| [src/group-turn-policy.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/group-turn-policy.ts) | Prompt shaping and outbound delivery policy |
| [src/group-queue.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/group-queue.ts) | Per-chat execution ownership and idle eviction |
| [src/slash-commands.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/slash-commands.ts) | Slash routing and host-owned commands |
| [src/container-config.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/container-config.ts) | Mounts, env, personal/main-folder privilege construction |
| [src/container-runner.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/container-runner.ts) | Container spawn and streaming output handling |
| [src/container-contract.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/container-contract.ts) | Host-side container protocol |
| [src/container-snapshots.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/container-snapshots.ts) | Task/group snapshot writers |
| [src/ipc-watcher.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/ipc-watcher.ts) | IPC transport loop |
| [src/ipc-task-handler.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/ipc-task-handler.ts) | IPC capability handling |
| [src/orchestrator-runtime.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/orchestrator-runtime.ts) | Subsystem startup and host-side service APIs |
| [src/db.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/db.ts) | SQLite persistence |

## Merge-Hardening Guidance

These are the local seams that now exist specifically to reduce future merge pain with `upstream/main`:

- keep `src/index.ts` thin; do not move policy back into it
- keep IPC transport concerns in `src/ipc-watcher.ts`, not `src/ipc.ts`
- keep container protocol, timeout policy, and snapshot writing out of `src/container-runner.ts`
- keep group prompt/delivery policy in `src/group-turn-policy.ts`, not mixed back into `src/group-agent-runner.ts`

Current remaining hot spots for future merges:
- [src/container-config.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/container-config.ts)
- [src/orchestrator-runtime.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/orchestrator-runtime.ts)
- [container/agent-runner/src/index.ts](/Users/nasen.you/Projects/GH/NanoClaw/container/agent-runner/src/index.ts)
- [src/channels/ringcentral.ts](/Users/nasen.you/Projects/GH/NanoClaw/src/channels/ringcentral.ts)

For branch and upstream maintenance workflow, also see [docs/BRANCH-FORK-MAINTENANCE.md](/Users/nasen.you/Projects/GH/NanoClaw/docs/BRANCH-FORK-MAINTENANCE.md).
