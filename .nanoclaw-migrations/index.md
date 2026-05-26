# NanoClaw Migration Guide

Generated: 2026-05-26 10:58 Asia/Shanghai
Base: 29839464bff39b7672c0a7504d9bb7649a79c5f1
HEAD at generation: 31cdfd76
Upstream: 24922593

## Migration Plan

This fork is a complex v1/custom branch moving onto upstream NanoClaw v2. Do not merge
`upstream/main` directly: the dry-run merge conflicted across package manager files,
container runtime, channel registry, DB/task modules, group prompts, and old skill-engine
files.

Use a clean v2 worktree from `upstream/main`, then reapply only current intentional
customizations. Data directories (`data/`, `groups/`, `.env`, runtime state) must not be
changed during code migration.

Recommended staging:

1. Start from `upstream/main` v2.
2. Install or preserve v2-compatible channel skills for WhatsApp and Slack.
3. Rebuild RingCentral as a v2 `ChannelAdapter`; there is no upstream RingCentral v2 skill.
4. Rebuild custom provider support as v2 provider modules under
   `container/agent-runner/src/providers/`.
5. Reintroduce enterprise MCP capability routing through v2 `container.json`/provider MCP
   configuration, not the old v1 IPC runner.
6. Reintroduce admin/specialist-agent policy as v2 groups, roles, permissions, and
   module/tool allowlists.
7. Validate with `pnpm install`, `npm run build`, and focused tests before swapping.

## Applied Skills

This fork contains legacy skill-engine skill directories rather than clean branch-based
skill merge history. Treat these as installed capabilities to preserve, but prefer their v2
upstream skill versions where available:

- WhatsApp: preserve via upstream v2 `/add-whatsapp` skill.
- Slack: preserve via upstream v2 `/add-slack` skill.
- Gmail: preserve via upstream v2 `/add-gmail` or v2 MCP/Gmail-tool skill as appropriate.
- Compact/session commands: v2 has compaction and prompt addendum behavior; do not copy old
  `add-compact` source blindly.
- Image vision, PDF reader, voice transcription, reactions, Ollama, local Whisper: preserve
  only if still required; port through v2 skills or container skills instead of old
  skill-engine patches.
- RingCentral: custom local skill only; must be ported manually to a v2 channel adapter.

Custom skills/directories to keep as reference only:

- `.claude/skills/add-ringcentral/`
- `.claude/skills/x-integration/` was intentionally removed by local history and should
  remain removed unless explicitly requested.

## Skill Interactions

- Old skill-engine directories modify the same hot files that v2 replaced
  (`src/index.ts`, `src/container-runner.ts`, `container/agent-runner/src/index.ts`,
  `src/channels/index.ts`). Do not copy those patches into v2.
- WhatsApp-related old skills stack changes for voice transcription, image vision, PDF
  reader, and reactions onto the old WhatsApp adapter. In v2, these must be reintroduced as
  channel formatting/container skills or Chat SDK adapter behavior.
- Provider customizations and enterprise MCP routing interact: the OpenAI provider depends
  on `mcp-registry.ts`, durable/working memory helpers, and a tool execution loop. Port them
  together.
- RingCentral personal-send behavior, owner-auth policy, and on-behalf labels interact with
  admin-agent permissions. Port them as a single v2 channel + permission feature.

## Customizations

### Pluggable Claude/OpenAI Agent Backend

Intent: Support both Claude SDK and OpenAI Responses API-compatible agents behind the
NanoClaw credential proxy.

Current files:

- Host: `src/agent-backends.ts`, `src/agent-backend.ts`, `src/agent-backends.ts`,
  `src/credential-proxy.ts`, `src/container-config.ts`, `src/container-contract.ts`
- Container: `container/agent-runner/src/providers/openai.ts`,
  `container/agent-runner/src/providers/openai-utils.ts`,
  `container/agent-runner/src/providers/mcp-registry.ts`,
  `container/agent-runner/src/providers/working-memory.ts`,
  `container/agent-runner/src/providers/durable-memory.ts`,
  `container/agent-runner/src/providers/index.ts`

How to apply on v2:

- Use v2 provider registration (`container/agent-runner/src/providers/provider-registry.ts`
  and `providers/index.ts`).
- Implement OpenAI as an `AgentProvider` matching v2
  `container/agent-runner/src/providers/types.ts`: `query(input)`, `isSessionInvalid()`,
  optional `maybeRotateContinuation()`, and event stream output.
- Use v2 `ProviderOptions` for model/effort/env/MCP servers instead of v1
  `AgentTurnContext`.
- Preserve env/config behavior:
  - `AGENT_BACKEND=claude|openai`
  - `AGENT_MODEL` / `OPENAI_MODEL`
  - `OPENAI_BASE_URL`
  - `OPENAI_API_KEY`
  - Claude auth may use `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.
- Keep OpenAI tool-loop safeguards: bounded tool loop count, bounded tool output, retry
  transient API failures, and dedupe repeated `send_message` calls.
- Rework MCP server discovery to v2's `mcpServers` config shape.

### Enterprise MCP Capability Routing

Intent: Give agents controlled access to enterprise tools only when relevant and authorized.

Current capabilities:

- Gmail
- Jira / Atlassian
- TestIt
- Figma
- GitLab
- Microsoft 365

Current files:

- `container/agent-runner/src/providers/mcp-registry.ts`
- `container/agent-runner/src/providers/gitlab-mcp-server.ts`
- Host-side env forwarding in `src/container-config.ts` and related tests.

How to apply on v2:

- Prefer v2 `container.json`/per-group `mcpServers` for static MCP servers.
- For prompt-gated OpenAI tools, port `mcp-registry.ts` into the OpenAI provider module and
  derive allowed servers/tools from v2 config plus per-group policy.
- Preserve env keys: `JIRA_TOKEN`, `CONFLUENCE_READ_TOKEN`, `TESTIT_ACCESS_TOKEN`,
  `GITLAB_PERSONAL_ACCESS_TOKEN`, Outlook/M365 credentials, and Figma MCP mount path.
- Preserve internal npm registry arguments for RingCentral MCP packages where used.
- Keep reduced/public TestIt tool access when no `TESTIT_ACCESS_TOKEN` exists.

### Durable Memory and Runbook Governance

Intent: Maintain bounded group memory, user preferences, searchable session/history memory,
and runbooks with governance/review operations.

Current files:

- `src/durable-memory.ts`
- `src/runbook-manager.ts`
- `src/search-index.ts`
- `container/agent-runner/src/providers/durable-memory.ts`
- `container/agent-runner/src/providers/working-memory.ts`
- Related tests under `src/*memory*.test.ts`, `src/runbook-manager.test.ts`,
  `container/agent-runner/src/providers/*memory*.test.ts`

How to apply on v2:

- Map managed durable memory to v2 group files, especially `CLAUDE.local.md`, `MEMORY.md`,
  and `USER.md`.
- Preserve the managed marker convention:
  `<!-- nanoclaw-managed:start -->` / `<!-- nanoclaw-managed:end -->`.
- Preserve bounds: short entries, deduplication by title/content, max entry count, and max
  rendered characters.
- Recreate MCP/tool commands only if v2 modules do not already cover the use case:
  `manage_memory`, `search_memory`, `search_sessions`, `search_group_history`,
  `review_memory`, `manage_runbook`.

### RingCentral Channel and Personal Send Policy

Intent: Keep RingCentral as a first-class channel with group/team routing, direct-chat
resolution, personal-account sends, on-behalf labeling, presence/contact tools, and safe
owner-only behavior.

Current files:

- `src/channels/ringcentral.ts`
- `src/rc-auto-register.ts`
- `src/rc-delivery-policy.ts`
- `src/on-behalf-message.ts`
- RingCentral helpers in `src/ipc-task-handler.ts`
- `.claude/skills/add-ringcentral/`

How to apply on v2:

- Implement `src/channels/ringcentral.ts` as a v2 `ChannelAdapter`.
- Register it through the v2 channel registry side-effect import pattern.
- Preserve behavior:
  - Prefer exact RingCentral team targets.
  - Stabilize direct-message lookup and sync fallback.
  - Ignore non-owner RingCentral DMs for owner-only controls.
  - Allow owner-authorized personal sends and label on-behalf messages.
  - Keep delivery-policy checks that prevent unintended personal-account sends.
- Recreate RingCentral tools as v2 MCP tools or module tools:
  `list_rc_chats`, `read_rc_messages`, `send_rc_message`, `send_rc_dm`,
  `list_rc_chat_members`, `get_rc_presence`, `set_rc_presence`, `get_rc_extension`,
  `list_rc_extensions`, `list_rc_contacts`, `create_rc_contact`,
  `list_rc_phone_numbers`.
- Preserve env keys: `RC_CLIENT_ID`, `RC_CLIENT_SECRET`, `RC_JWT`, `RC_SERVER`.

### Admin Specialist Agents

Intent: Let an owner/supervisor delegate work to scoped specialist agents with controlled
tools, external MCP capabilities, mounts, and peer permissions.

Current files:

- `src/admin-agents.ts`
- `src/admin-delegation.ts`
- `src/supervisor-routing.ts`
- `groups/admin-agents.json` when present at runtime
- related tests under `src/admin-*.test.ts`, `src/supervisor-routing.test.ts`

How to apply on v2:

- Prefer v2's agent-to-agent module and group/destination model instead of v1
  `delegate_to_group` wiring.
- Preserve profile concepts:
  - `supervisor`
  - `ciops`
  - `peopleops`
  - `jiraops`
  - `gitops`
  - `testautomation`
  - `testdesign`
  - `featuredevelopment`
  - `codereview`
  - `rcvops`
- Preserve tool scoping:
  - Base tools: messaging, delegation, memory/runbook, scheduling.
  - Supervisor-only tools: registration, RingCentral write tools, NotebookLM tools.
  - External MCP capability allowlists per role.
  - Mount profiles: projects read/write, projects read-only, none.
  - Git auth only for trusted roles.

### NotebookLM Enterprise Source Tools

Intent: Allow supervisor agents to list/create/read NotebookLM notebooks and add sources.

Current files:

- `src/notebooklm.ts`
- `src/notebooklm.test.ts`
- tool dispatch in `src/ipc-task-handler.ts`

How to apply on v2:

- Recreate as a v2 module/MCP tool group.
- Preserve tool names:
  `list_notebooklm_notebooks`, `create_notebooklm_notebook`,
  `get_notebooklm_notebook`, `add_notebooklm_sources`.
- Keep these tools supervisor-only unless a narrower v2 permission exists.

### Git Auth and Project Mounts

Intent: Personal-mode agents can use owner Git credentials and inherited personal mounts;
other agents get read-only or no mounts.

Current files:

- `src/git-auth.ts`
- `setup/git-auth.ts`
- `src/container-config.ts`
- `src/container-runner.ts`
- `src/mount-security.ts`
- `container/agent-runner/src/providers/openai.ts`

How to apply on v2:

- Use v2 mount and `container.json` mechanisms.
- Preserve owner-only Git auth directory mounting and `GIT_CONFIG_GLOBAL` pointing at the
  generated container git config.
- Preserve TLS CA bundle mounts:
  `WEB_FETCH_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, and fallback handling for intercepted TLS
  environments.
- Keep `/workspace/project` read-only unless explicit personal mode/mount policy grants
  write access elsewhere.

### Emergency Service Disable

Intent: Admin chats can disable NanoClaw quickly; disabling prevents new work and stops
active/queued work.

Current files:

- `src/service-control.ts`
- `src/service-state.ts`
- `src/app-controls.ts`
- service checks in message/task/group queue code

How to apply on v2:

- Recreate `enable service`, `disable service`, `turn on nanoclaw`,
  `turn off nanoclaw` owner/admin commands.
- Persist service-enabled state in v2 DB/config.
- Ensure disabled state prevents new inbound processing and pauses scheduled work.

### Runtime Boundary Refactors

Intent: Keep host/container protocol boundaries explicit to reduce future merge conflicts.

Current files:

- `src/container-contract.ts`
- `src/container-snapshots.ts`
- `src/ipc-message-handler.ts`
- `src/ipc-task-handler.ts`
- `src/ipc-types.ts`
- `src/ipc-watcher.ts`
- `src/orchestrator-runtime.ts`
- `src/channel-bootstrap.ts`
- `src/message-loop.ts`
- `src/message-gating.ts`
- `src/task-execution.ts`

How to apply on v2:

- Do not copy v1 IPC files into v2; v2 uses session DBs and modules.
- Preserve the intent by keeping new custom v2 code behind module/provider/channel seams
  instead of editing core `src/index.ts` or `container-runner.ts`.
- Add new behavior as v2 modules under `src/modules/`, channel adapters under
  `src/channels/`, and provider modules under `container/agent-runner/src/providers/`.

### Local Documentation and Architecture Notes

Intent: Preserve local documentation about customized runtime boundaries and branch/merge
maintenance.

Current files:

- `AGENTS.md`
- `ARCHITECTURE.md`
- `docs/BRANCH-FORK-MAINTENANCE.md`
- `docs/EXTENDING.md`
- `docs/hermes-strengthening-plan.md`
- `groups/global/ringcentral-api.md`
- `groups/global/jenkins-api.md`

How to apply on v2:

- Keep `AGENTS.md` and local architecture/maintenance docs.
- Reconcile with upstream v2 docs instead of replacing them wholesale.
- Preserve group API reference docs under `groups/global/` if they are still used by the
  owner/supervisor agents.

## Deferred/Do Not Port Blindly

- `skills-engine/` and related scripts (`apply-skill.ts`, `validate-all-skills.ts`,
  `fix-skill-drift.ts`, `uninstall-skill.ts`) are obsolete in v2. Keep only as historical
  reference unless a specific workflow still depends on them.
- Old v1 channel registry files should not be copied over v2 channel adapter registry files.
- Old package-lock files should not be reintroduced into v2's pnpm workspace unless a
  compatibility reason is proven.
- The removed X integration should remain removed.
