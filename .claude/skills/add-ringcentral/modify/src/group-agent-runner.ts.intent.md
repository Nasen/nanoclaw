# Intent: src/group-agent-runner.ts modifications

## What changed
Adds RingCentral-aware personal context handling to group execution.

## Key behavior

- treats folders declared by `rc-auto-register.ts` as `isMain` or `personalMode`
- prepends the auto-assist prompt for owner RingCentral DMs when auto-assist is enabled
- preserves the existing session and snapshot flow

## Must-keep

- normal non-RingCentral groups must keep their existing behavior
- per-group session isolation and queue registration remain unchanged
