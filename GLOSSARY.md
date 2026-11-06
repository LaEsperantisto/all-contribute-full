# Glossary

Vocabulary for All Contribute. No implementation details here.

## Content

- **Block definition** — a registered block with its properties and behaviour rules. The unit of player-created content alongside recipes.
- **Built-in block** — a block owned by SYSTEM under the `builtin:` namespace. Immutable for everyone.
- **Player block** — a block under the `player:<username>:<id>` namespace. Only its creator can change it.
- **Behaviour rules** — what a block does, expressed declaratively for now (support rule, incompatibility list). Player-authored executable behaviour is a later phase (ADR 0001).
- **Support rule** — the condition on the block beneath a placement position that governs whether it may be placed: any, solid-only, or none (requires empty below).
- **Incompatible blocks** — a block can name other blocks it must never touch. Placing next to one is refused and the item stays with the player.
- **Placement outcome** — the three results of a placement attempt: placed, refused (block returned to the player), or transformed by the block beneath (player-controlled via behaviour).
- **Conflict** — two active block behaviours demanding contradictory world changes (e.g. one shoves neighbours right, another shoves them left). The game must never crash; the blocks involved break instead. Reaches full meaning with executable behaviour (ADR 0001).
- **Recipe** — ingredients consume item stacks and create a result item; authored in-game like blocks.
- **Entity / mob** (phased) — a player-authored creature, registered like a block and governed by the same namespace policies.

## World

- **World** — one shared voxel world: columns of blocks addressed by `(x, y, z)` with y measured upward from an unbreakable bedrock floor. Base terrain (land, caves, trees) is a deterministic function of coordinates; what differs from it is player-made.
- **Voxel** — one unit cube of the world at a coordinate triple. The word "cell" is no longer used: the world is 3D end to end.
- **Edit** — a player-caused world change: a placement or a cleared voxel, recorded at its `(x, y, z)`. The world is base terrain plus edits.

## Ownership and hosting

- **Inventory** — a logged-in player's server-owned item stacks. Placement debits, refusal never debits, breaking credits.
- **Server (owned)** (phased) — a community-hosted world instance. Its owner alone chooses which namespaces' blocks and entities are whitelisted or blacklisted there.
