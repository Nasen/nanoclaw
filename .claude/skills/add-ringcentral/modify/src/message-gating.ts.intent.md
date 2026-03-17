# Intent: src/message-gating.ts modifications

## What changed
Adds a RingCentral-specific helper for identifying owner personal DMs.

## Key behavior

- `isPersonalRcDm()` returns true for `rc:` chats mapped to a main or personal RingCentral folder
- existing trigger checks remain unchanged

## Must-keep

- trigger gating for non-RingCentral groups must behave exactly as before
