-- What a scripted block can do beyond remembering keys and painting light:
--
--   * block_inventory — the cell's own item store. A script fills it with
--     `inv_add`, empties it with `inv_take`, and reads it with `inv_count` /
--     `inv_list`; quantities mirror the 0..999 bound of a held stack. The rows
--     belong to the cell, exactly like `block_state`, so they survive a
--     rejoin and die with the block (the breaker is handed whatever is left).
--   * player_state.spawn_* — the respawn anchor. NULL means "the world's own
--     spawn", which is what every player had before; `set_player_respawn_position`
--     lets a scripted block move it, and the respawn handler reads it.
--   * The beacon's script gains `on_break`, the worked example of the break
--     hook the server now calls before it wipes a cell's memory.
ALTER TABLE player_state ADD COLUMN spawn_x REAL;
ALTER TABLE player_state ADD COLUMN spawn_y REAL;
ALTER TABLE player_state ADD COLUMN spawn_z REAL;

CREATE TABLE IF NOT EXISTS block_inventory (
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity >= 0 AND quantity <= 999),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (x, y, z, item_id)
);

UPDATE blocks SET script =
'-- Beacon: pick a colour, and a column of that light rises to the sky.
local NAMES = { red = "Red", blue = "Blue", green = "Green", gold = "Gold" }
local HEX = { red = "#ff4d4d", blue = "#4d9fff", green = "#5ed46a", gold = "#f3c76b" }
local ORDER = { "red", "blue", "green", "gold" }

function on_interact()
  local now = state_get("colour")
  local title = "Beacon colour"
  if now and NAMES[now] then
    title = "Beacon colour (now " .. NAMES[now] .. ")"
  end
  local options = {}
  for i = 1, #ORDER do
    options[i] = { key = ORDER[i], label = NAMES[ORDER[i]] }
  end
  options[#options + 1] = { key = "off", label = "Turn it off" }
  return { title = title, options = options }
end

function on_choice(key)
  if key == "off" then
    state_set("colour", nil)
    beam(nil)
    toast("Beacon off.")
    return
  end
  if not HEX[key] then
    toast("Unknown colour.")
    return
  end
  state_set("colour", key)
  beam(HEX[key])
  toast("Beacon is now " .. NAMES[key] .. ".")
end

function on_break(player)
  -- Called before the cell''s memory is wiped, so the script still sees its
  -- own state. The column is server state and the break takes it down either
  -- way; beam(nil) says so here as well, which is what keeps a block that
  -- paints anything else from leaving its light behind.
  beam(nil)
  toast("The beacon goes dark.")
end
' WHERE id = 'builtin:beacon';
