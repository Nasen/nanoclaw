# Intent: src/container-config.ts modifications

## What changed
Allows personal-mode containers to receive the RingCentral owner credentials they need for RingCentral-aware tools and workflows.

## Key behavior

- forwards `RC_CLIENT_ID`, `RC_CLIENT_SECRET`, `RC_JWT`, and `RC_SERVER`
- only forwards them in `personalMode`
- keeps the existing proxy-based Anthropic credential model unchanged

## Must-keep

- do not expose these environment variables to every group container
- mount behavior and host gateway wiring stay unchanged
