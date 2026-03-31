# Branch & Fork Maintenance Guidelines

This file covers both upstream NanoClaw branch strategy and the practical merge discipline for customized downstreams like this repo.

## Structure

**`qwibitai/nanoclaw`** (upstream) — core engine with skill definitions (`.claude/skills/`). No channel code on `main`.

**Channel forks** (`nanoclaw-whatsapp`, `nanoclaw-telegram`, `nanoclaw-slack`, etc.) — each fork = upstream + one channel's code applied. Users clone upstream, then merge a fork into their clone to add a channel.

**`skill/*` and `feat/*` branches on upstream** — add features unrelated to channels (e.g. `skill/compact`, `skill/apple-container`). Users merge these into their clone to add capabilities. Channel-specific skill branches that duplicate the forks (e.g. `skill/whatsapp`, `skill/telegram`) are legacy.

## How users add capabilities

```
user clones upstream main
  ├── merges nanoclaw-whatsapp fork  → adds WhatsApp
  ├── merges skill/compact branch    → adds /compact command
  └── merges skill/apple-container   → switches to Apple Container
```

## Merge directions

```
upstream main ──→ channel forks     (forward merge to keep forks caught up)
upstream main ──→ skill branches    (forward merge to keep branches caught up)
```

Forks and skill branches carry applied code changes. Users merge them into their own clones/forks to add capabilities. They are never merged back into upstream `main`.

## Forward merge procedure

```bash
# In your local nanoclaw checkout
git checkout main && git pull

# For a fork:
git fetch nanoclaw-whatsapp
git checkout -B whatsapp-merge nanoclaw-whatsapp/main
git merge main
# Resolve conflicts (see below)
# Remove upstream-only workflows (re-added by every merge since main has them):
git rm .github/workflows/bump-version.yml .github/workflows/update-tokens.yml 2>/dev/null
git push nanoclaw-whatsapp HEAD:main
git checkout main && git branch -D whatsapp-merge

# For a skill branch:
git checkout -B skill/compact origin/skill/compact
git merge main
# Resolve conflicts (see below)
git push origin skill/compact
git checkout main && git branch -D skill/compact
```

## Conflict resolution

The same files conflict every time:

| File | Resolution |
|------|------------|
| `package.json` | Take main's version + keep fork/branch-specific deps |
| `package-lock.json` | `git checkout main -- package-lock.json && npm install` |
| `.env.example` | Combine: main's entries + fork/branch-specific entries |
| `repo-tokens/badge.svg` | Take main's version (auto-generated) |

Source code changes (e.g. `src/types.ts`, `src/index.ts`) usually auto-merge cleanly, but can conflict if both sides modify the same lines. **Always build and test after every forward merge** — auto-merged code can be silently wrong (e.g. referencing a renamed function or using a removed parameter) even when git reports no conflicts.

## When to merge forward

After any main change that touches shared files (`package.json`, `src/index.ts`, `CLAUDE.md`, etc.). Small frequent merges = trivial conflicts. Large infrequent merges = painful.

## Customized Downstream Guidance

For a customized install that carries local channel logic, RC automation, security policy, sticky sessions, or GitOps behavior, the main goal is to keep local changes additive and modular so upstream merges land at stable seams instead of colliding inside hot orchestration files.

### Current merge-seam modules

These files were split specifically to reduce repeated conflicts:

| Area | Preferred seam |
|------|----------------|
| App startup and state wiring | `src/index.ts`, `src/app-runtime-state.ts`, `src/app-controls.ts`, `src/app-processing.ts` |
| Group prompt and delivery policy | `src/group-agent-runner.ts`, `src/group-turn-policy.ts`, `src/slash-commands.ts` |
| IPC transport vs capability handling | `src/ipc.ts`, `src/ipc-watcher.ts`, `src/ipc-types.ts`, `src/ipc-task-handler.ts` |
| Container protocol and lifecycle | `src/container-contract.ts`, `src/container-runner.ts`, `src/container-timeout.ts`, `src/container-snapshots.ts` |

### Rules for future feature work

- Prefer new local modules over expanding upstream hot files.
- If a change is NanoClaw-specific policy, put it beside the seam module that already owns that concern.
- If a change affects host/container payload structure, update the contract boundary deliberately and document it in `ARCHITECTURE.md`.
- Avoid pushing local RC policy, sticky-session policy, or security logic back into `src/index.ts`.
- Avoid turning `src/ipc.ts` back into a monolith.

### Remaining hot spots

These files are still likely to conflict with upstream:

- `src/container-config.ts`
- `src/orchestrator-runtime.ts`
- `container/agent-runner/src/index.ts`
- `src/channels/ringcentral.ts`

When merging upstream into a customized branch:

1. Merge upstream into the current branch early and often.
2. Reapply upstream logic at the seam boundary first.
3. Keep local policy in the local helper/module unless upstream made that module obsolete.
4. Run focused verification immediately after resolving each hotspot.

### Recommended merge cadence

- Merge `upstream/main` at least weekly when actively customizing.
- Enable and keep `git rerere` on.
- Prefer several small merge checkpoints over one large catch-up merge.

### Minimum post-merge verification

At minimum:

```bash
npm run typecheck
npm test -- src/group-agent-runner.test.ts src/container-runner.test.ts src/ipc-auth.test.ts src/message-loop.test.ts
```

If container or channel code changed, also verify the running service after rebuild/restart.

## Fork setup

When creating a new channel fork:

1. Fork `nanoclaw` to `nanoclaw-{channel}`
2. Remove upstream-only workflows: `bump-version.yml`, `update-tokens.yml`
3. Add channel code, deps, env vars
4. Forward-merge main immediately to establish a clean baseline

## Dependencies

Forks and branches add their own deps on top of upstream's. When upstream adds or removes a dependency, verify that forks/branches still build after the next forward merge — transitive dependency changes can break downstream code.
