# Intent: src/channel-bootstrap.ts modifications

## What changed
Adds explicit RingCentral bootstrap wiring outside the generic channel registry.

## Key behavior

- connects the JWT-backed owner channel as `rc:`
- connects the bot add-in channel as `rcb:` when bot credentials are present
- routes owner-only auto-assist toggle commands through `onOwnerCommand`
- confirms auto-assist state changes back into the owner's RingCentral chat

## Must-keep

- installed channels still connect through the generic registry path
- RingCentral failures are isolated and should not crash startup
- the bot add-in channel remains optional
