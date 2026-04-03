# Extending NanoClaw

This fork is easiest to maintain when each capability lands in the seam that already owns it.
Use this document as the boundary map before adding new code.

## Design Rules

- Keep entrypoints thin. Compose subsystems in one place, but put policy and runtime logic in focused modules.
- Register extensibility points explicitly. New channels, setup steps, and agent providers should appear in registries, not in scattered switches.
- Keep host and container concerns separate. Host code decides mounts, persistence, and orchestration; container code decides model/tool execution.
- Prefer additive seams over broad rewrites. If a new feature needs a new module boundary, add it once and route future work through it.

## Project Map

| Area                                    | Ownership                               | Extend here                                                                                  |
| --------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/index.ts`                          | Process entrypoint only                 | Rarely. Keep it limited to direct-run startup and backwards-compatible exports.              |
| `src/bootstrap/start-app.ts`            | Host bootstrap composition              | Wire together existing subsystems here. Do not move business logic back into the entrypoint. |
| `src/channels/`                         | Channel adapters and registration       | Add new channels under this directory and register them through `src/channels/registry.ts`.  |
| `src/agent-backends.ts`                 | Host-side backend catalog               | Add backend metadata and config resolution here.                                             |
| `container/agent-runner/src/providers/` | Container-side provider implementations | Add the runtime implementation here and register it in `providers/registry.ts`.              |
| `setup/`                                | Host setup and installation flow        | Add a new `run(args)` module and register it in `setup/steps.ts`.                            |
| `src/orchestrator-runtime.ts`           | Long-running host subsystems            | Add or remove background services here, not in bootstrap callers.                            |
| `src/container-*.ts`                    | Host/container boundary                 | Put mount/env/timeout/protocol changes in the specific boundary module that owns them.       |

## Adding A Channel

1. Create `src/channels/<name>.ts`.
2. Implement the `Channel` interface from `src/types.ts`.
3. Register it with `registerChannel({ ... })` in the same file.
4. Import the file from `src/channels/index.ts` so startup self-registers it.
5. If the channel needs setup work, add that via a skill or a dedicated setup step rather than hiding it in bootstrap.

Keep `src/channel-bootstrap.ts` focused on connection lifecycle. It should consume channel registrations, not grow channel-specific behavior beyond bootstrap exceptions like RingCentral.

## Adding An Agent Backend

Host side:

- Add backend metadata and config resolution in `src/agent-backends.ts`.
- Reuse `getAgentBackendConfig()` from `src/agent-backend.ts` everywhere else.

Container side:

- Implement the provider in `container/agent-runner/src/providers/<name>.ts`.
- Register it in `container/agent-runner/src/providers/registry.ts`.

If a backend needs special credential proxy behavior, keep that branching inside `src/credential-proxy.ts`. Do not let unrelated modules infer auth details on their own.

## Adding A Setup Step

1. Create `setup/<name>.ts` exporting `run(args: string[])`.
2. Add the step to `setup/steps.ts` with a concise summary.
3. Keep argument parsing in `setup/index.ts` generic. Step-specific behavior belongs in the step module.

The setup registry exists so `npm run setup -- --list` stays accurate without hand-maintaining help text.

## Where New Logic Should Go

If your change is about:

- inbound message admission or command interception: `src/app-controls.ts`
- polling and group processing orchestration: `src/app-processing.ts`
- per-chat turn shaping or delivery policy: `src/group-turn-policy.ts`
- session ownership / queueing / idle eviction: `src/group-queue.ts`
- host/container protocol or mount policy: `src/container-contract.ts`, `src/container-config.ts`, `src/container-timeout.ts`
- file-based IPC transport: `src/ipc-watcher.ts`, `src/ipc-task-handler.ts`, `src/ipc-message-handler.ts`

When a change crosses multiple rows in that list, start by introducing or reusing a boundary module rather than widening an existing grab-bag file.

## Anti-Patterns

- Do not add feature-specific branching directly to `src/index.ts`.
- Do not add new backend/channel names via magic strings in unrelated modules.
- Do not mix host filesystem policy with container provider behavior.
- Do not hide setup capabilities in README prose only; register them in `setup/steps.ts`.

For the current runtime topology, see `ARCHITECTURE.md`.
