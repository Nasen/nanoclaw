# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [ARCHITECTURE.md](ARCHITECTURE.md) for the current local module map and [docs/BRANCH-FORK-MAINTENANCE.md](docs/BRANCH-FORK-MAINTENANCE.md) for merge discipline.

## Quick Context

Single Node.js host process with a split orchestration layer:
- `src/index.ts` is now a composition root only
- runtime state lives in `src/app-runtime-state.ts`
- inbound control and storage live in `src/app-controls.ts`
- message-loop and chat processing adapters live in `src/app-processing.ts`
- IPC transport is split into `src/ipc-watcher.ts` and `src/ipc-task-handler.ts`
- container lifecycle is split across `src/container-contract.ts`, `src/container-runner.ts`, `src/container-snapshots.ts`, and `src/container-timeout.ts`

Chats use sticky per-chat sessions with parked containers where possible. `rc-personal` is the owner DM. Main/admin folders inherit owner-style extra mounts, but non-owner RC DMs are blocked.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Startup composition root |
| `src/app-runtime-state.ts` | Persisted runtime state and registered group state |
| `src/app-controls.ts` | Inbound channel callbacks and service-control handling |
| `src/app-processing.ts` | Message-loop and per-chat processing adapters |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/group-agent-runner.ts` | Per-chat turn orchestration |
| `src/group-turn-policy.ts` | Prompt shaping and outbound delivery rules |
| `src/ipc.ts` | Thin IPC barrel |
| `src/ipc-watcher.ts` | IPC transport loop |
| `src/ipc-task-handler.ts` | IPC host-side capability handling |
| `src/container-contract.ts` | Host/container protocol markers and types |
| `src/container-runner.ts` | Spawns agent containers and parses streaming output |
| `src/container-config.ts` | Mounts, env, personal/main-folder privilege construction |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

For merge-sensitive refactors or downstream upkeep, also read [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/BRANCH-FORK-MAINTENANCE.md](docs/BRANCH-FORK-MAINTENANCE.md) first.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
