-- The beacon: a builtin block programmed in sandboxed Lua, shipped as the
-- worked example of the `script` feature. Interacting with it (E in game) opens
-- a colour menu; choosing a colour stores it in that cell's state and switches
-- on a column of light that rises from the beacon to the top of the world.
--
-- Only the host's own globals are available (state_get/state_set/menu/beam/
-- toast/log), the script is instruction/wall-clock budgeted, and it never sees
-- another cell's state.
INSERT OR IGNORE INTO blocks
(id,name,creator_name,hardness,light,colour,behaviour,is_builtin,script)
VALUES
('builtin:beacon','Beacon','SYSTEM',0.4,10,'#cfe8ff','glowing',1,
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
');

-- The held form, so the beacon can be placed at all: blocks are placed through
-- the item that programmes them.
INSERT OR IGNORE INTO items
(id,name,creator_name,kind,place_block_id,damage,speed,heal,durability,colour,is_builtin)
VALUES
('builtin:beacon','Beacon','SYSTEM','block','builtin:beacon',0,1,0,0,'#cfe8ff',1);
