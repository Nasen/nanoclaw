# Intent: src/index.ts modifications

## What changed
Adds the RingCentral orchestration state and startup wiring needed by the skill.

## Key behavior

- persists `auto_assist_enabled` in router state
- exposes `setAutoAssist()` for RingCentral owner commands
- calls `connectRingCentralChannels()` during startup
- preserves the existing message storage, queue, and scheduler behavior

## Must-keep

- auto-assist defaults to off
- RingCentral startup should be additive, not a replacement for existing channels
