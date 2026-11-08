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
- **Item** — what a player holds, carries, and consumes: the unit of the held-thing registry, distinct from a block (what occupies a voxel). Every block has an item that places it; tools, weapons, food, and materials are items with no voxel form.
- **Item kind** — what an item is for: placeable (`block`), mining aid (`tool`), attack (`weapon`), eaten (`food`), or crafting input only (`material`). Stats belong to the kind: speed, damage, healing, durability.
- **Programme** — the one declarative act a placeable item performs: the block it puts into the world. Authored by the item's creator as data.
- **Block script** — what a block does when a player uses it, authored by the block's creator and run by the server. Behaviour rules still decide where a block may stand; a script decides what happens when it is used.
- **Interaction** — using the block under the crosshair (**E**). A block with no script does nothing when used; a block whose script fails to run says so, with the interpreter's complaint, so a broken block is never just a dead one.
- **Menu** — a block script's question to the player: a title and a list of choices. Making a choice is a second interaction with the same block.
- **Look** — the one player choice about visual detail: *flat* (everything painted from its registered colour) or *detailed* (the appearance its publisher supplied). One choice, so a block and an item can never disagree about how they look.
- **Texture, model, icon** — the appearance attached to published content: a block's surface image, the shape it asks for, an item's picture. All optional; the registered colour is the fallback for anyone on *flat*.
- **Built-in item** — an item owned by SYSTEM under the `builtin:` namespace. Immutable for everyone.
- **Player item** — an item under the `player:<username>:<ns>:<id>` namespace. Only its creator can change it.
- **Appearance** — the four colours an account owns for its avatar: head, body, legs and eyes. Stored per user, relayed on presence frames, and re-coloured live. Eyes are drawn on the head, so they are the only part that says which way a body is facing.
- **Entity / mob** — a creature the world object simulates: it walks on the surface, and is either hostile (seeks the nearest living player within a 40-block sphere, damages them when the 3D gap closes to 1.8 blocks) or peaceful (wanders). Range is measured in all three axes, so altitude is protection; only the mob's *steering* is horizontal. Hostility is a property of the creature, not of the player.
- **Health** — a player's 0–20 life total, owned by the server. Zero means dead: no movement, no damage, and the only way back is respawn.
- **Respawn** — returning a dead player to the surface spawn with full health.

## World

- **World** — one shared voxel world: columns of blocks addressed by `(x, y, z)` with y measured upward from an unbreakable bedrock floor. Base terrain (land, caves, trees) is a deterministic function of coordinates; what differs from it is player-made.
- **Voxel** — one unit cube of the world at a coordinate triple. The word "cell" is no longer used: the world is 3D end to end.
- **Edit** — a player-caused world change: a placement or a cleared voxel, recorded at its `(x, y, z)`. The world is base terrain plus edits.
- **Voxel record (composite id)** — the number a voxel cell actually stores for a block, and the entry in a thread's voxel tables that turns a block name into it. The numbers are positional and shared: every thread that touches voxels has to use the same one for the same name, or one thread's placement reads as another's different block. A name only encodes when its record slot decodes back to that name; blocks the terrain never generates have to be aligned to the numbers the server-side engine already used, never renumbered, because an unrecorded name encodes as air and a placement writes nothing and stays silent.
- **Voxel state** — what a block script remembers about a particular voxel. It belongs to the place, not to the player or the block type: two identical blocks in two places are independent, and breaking the block forgets it.
- **Light column** — a column of coloured light running from a voxel to the top of the world, switched on and off by the block standing there. It is part of the world's state, so it survives a reload and is there for a player who arrives later.

## Ownership and hosting

- **Inventory** — a logged-in player's server-owned item stacks. Placement debits, refusal never debits, breaking credits.
- **Bag order** — a player's own arrangement of their stacks. The hotbar is the front of the bag, so arranging the bag arranges the hotbar. Only the player arranges their own.
- **Admin** — the single account allowed to change item counts on accounts (grant, remove, clear). Arranging one's own inventory is not an admin act.
- **Server (owned)** (phased) — a community-hosted world instance. Its owner alone chooses which namespaces' blocks and entities are whitelisted or blacklisted there.
