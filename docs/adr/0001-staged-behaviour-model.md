# 1. Staged behaviour model: declarative components first, sandboxed player code later

Date: 2026-11-06
Status: accepted

## Context

The game's core mechanic is players creating blocks by "sending code to the server", Bedrock-addon style. Cloudflare Workers (free tier) cannot safely run untrusted code server-side, and the described crash rule (conflicting blocks break, the game never crashes) requires execution isolation.

## Decision

Ship block behaviour in two stages:

1. Now: declarative, validated components (support rule, incompatibility list, and future fixed-vocabulary components). The Worker validates them as data; nothing is executed server-side.
2. Later: player-submitted behaviour scripts, stored versioned by the server but executed only client-side, each block's script isolated so a crash quarantines that block — it breaks or falls back to inert properties; the game survives. On conflict between two blocks' behaviours, both blocks break; there is no engine crash.

## Consequences

- The API's `rules_json` column is the extension point; executable scripts will version beside it, not replace it.
- Expressiveness is capped until phase 2; the component vocabulary must be chosen deliberately.
- Sandbox design (Web Worker per block script, capability-limited context API) is a prerequisite for phase 2 and must be reviewed seriously before accepting any player code.
