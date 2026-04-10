# Hermes-Inspired Strengthening Plan For NanoClaw

## Why This Exists

NanoClaw already has strong foundations:

- per-group isolation
- persistent sessions
- durable knowledge files
- a host-enforced tool bridge

What it lacks is a first-class bounded memory layer that sits between raw conversation history and long-lived runbooks. Hermes Agent is notably stronger in this area through:

- bounded persistent memory via `MEMORY.md` and `USER.md`
- toolsets that expose or restrict capability bundles cleanly
- searchable cross-session recall
- a stronger path from repeated workflows to reusable skills

Reference material:

- Hermes features overview: https://hermes-agent.nousresearch.com/docs/user-guide/features/overview
- Hermes repository: https://github.com/NousResearch/hermes-agent

## Strengthening Goals

1. Make NanoClaw memory more explicit, bounded, and testable.
2. Reduce reliance on opaque provider session state for long-running chats.
3. Separate stable user preferences from group-local working memory.
4. Keep host-side policy enforcement in NanoClaw instead of relying on prompt discipline alone.
5. Add stronger retrieval and procedural reuse without bloating the core runtime.

## Current Gap Summary

Today NanoClaw primarily relies on:

- SQLite message history in `store/messages.db`
- per-group provider session IDs
- archived conversation transcripts
- manually curated `CLAUDE.md`, runbooks, and knowledge files

That gives continuity, but it does not yet give NanoClaw a bounded curated memory layer. Session continuity and durable knowledge exist, but they are not the same thing.

## Proposed Roadmap

### Phase 1: Bounded Durable Memory

Add host-managed, bounded memory files to each group:

- `MEMORY.md`: stable group-local facts, working conventions, reusable facts
- `USER.md`: stable user preferences and communication guidance for that group

Implementation principles:

- writes go through a host-enforced `manage_memory` tool
- memory entries are concise and deduplicated
- files use a managed section with bounded size
- providers load these files automatically each turn

This phase is the best first step because it improves behavior immediately without changing the scheduling, routing, or channel model.

### Phase 2: Searchable Session Recall

Add SQLite FTS-backed retrieval over:

- stored chat messages
- archived conversation summaries
- durable memory entries

Expose host tools like:

- `search_memory`
- `search_sessions`
- `search_group_history`

This is the Hermes-style cross-session recall piece NanoClaw currently lacks.

### Phase 3: Session Compaction

Add explicit working-memory summaries so long-lived chats do not depend only on provider-managed resume state.

Targets:

- compact conversation state into a bounded summary file
- summarize inactive long-running sessions
- feed summaries into future turns before raw history

### Phase 4: Capability Bundles

Formalize NanoClaw tool bundles by role:

- messaging-basic
- research
- owner
- specialist
- supervisor
- code

NanoClaw already has role-aware controls. This phase makes them easier to reason about and extend.

### Phase 5: Procedural Skill Promotion

Allow NanoClaw to draft reusable runbooks or skills from repeated successful work:

- repeated troubleshooting patterns become runbooks
- repeated bounded workflows become candidate skills
- promotion remains human-reviewed at first

## What This Change Implements

The current implementation now covers Phases 1 through 5 in an initial production slice.

Included now:

- bounded `MEMORY.md` and `USER.md` files per group
- a host-managed `manage_memory` tool exposed through the NanoClaw MCP bridge
- SQLite FTS search over chat history and indexed group documents
- host tools for `search_memory`, `search_sessions`, and `search_group_history`
- a host `review_memory` tool for stale-memory review, candidate promotion context, and memory activity inspection
- `WORKING_MEMORY.md` snapshots written from both Claude and OpenAI provider flows
- role bundle updates for retrieval and runbook-promotion tools
- host-managed `manage_runbook` support for `runbook` and `skill_candidate` outputs, plus promotion from candidate to approved runbook
- indexing for runbooks, skill candidates, and archived conversation markdown
- memory event telemetry for writes, searches, reviews, and promotions
- focused tests covering file updates, provider loading, IPC wiring, working-memory compaction, and retrieval

Still intentionally deferred:

- global user modeling across groups
- automatic autonomous promotion from candidate skill to approved production skill
- automatic stale-entry pruning heuristics
- RL or model-training style adaptation

## Expected Outcome

After this phase NanoClaw should be materially stronger at:

- retaining stable preferences without polluting `CLAUDE.md`
- keeping group-local durable facts in a predictable place
- surviving session resets with less behavioral drift
- making memory updates auditable and bounded

## Follow-Up Work

The next iteration should focus on operational refinement:

- tune stale-age thresholds and ranking heuristics with real usage data
- add UI or slash-command surfaces for memory review and promotion workflows
- decide whether approved runbooks should promote further into first-class executable skills
