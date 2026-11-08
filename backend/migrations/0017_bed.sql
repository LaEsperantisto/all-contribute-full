-- The bed: sleep in it, and that cell becomes your spawn point.
--
-- The block is programmed in sandboxed Lua like the beacon: interacting with it
-- (E in game, crosshair on it) asks the host to move the account's respawn
-- anchor. `set_player_respawn_position` only writes `player_state.spawn_x/y/z`;
-- the server's own respawn path (`POST /api/player/respawn`, the death screen's
-- button) already prefers those columns and spreads players out, so nothing on
-- the server side changes here.
--
-- The anchor is an eye position, like every other position in the protocol: the
-- cell centre horizontally, one block plus eye height (1.7) above the bed.
-- Breaking the bed does not clear the anchor - respawning there is still a
-- legal column unless you removed the ground under it, and placing a new bed
-- (which the drop gives you back) moves it again.
INSERT OR IGNORE INTO blocks
(id,name,creator_name,hardness,light,colour,behaviour,is_builtin,texture,script)
VALUES
('builtin:bed','Bed','SYSTEM',0.4,0,'#b03a3a','solid',1,
'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAY0lEQVR42mPY1BXznxLMUBNh9p8SzLDByur/t68fcWKQPD4MNuDFswc4Mf0MOH9qLwYmyoA+HZ3/lGAGQjbA8ImQEDgbpBHFCyPdAIrzwuwC1/+UYLAXsrz0wJhY7yCrp9gAAKvAV7fY8PdPAAAAAElFTkSuQmCC',
'-- Bed: sleep here, and this is where you wake up if you die.
function on_interact()
  -- The anchor is an eye position: cell centre, one block plus eye height up.
  set_player_respawn_position(x + 0.5, y + 2.7, z + 0.5)
  state_set("anchor", x .. "," .. y .. "," .. z)
  toast("You will wake up here.")
end
');

-- The held form, so the bed can be placed at all: blocks are placed through the
-- item that programmes them.
INSERT OR IGNORE INTO items
(id,name,creator_name,kind,place_block_id,damage,speed,heal,durability,colour,is_builtin,icon)
VALUES
('builtin:bed','Bed','SYSTEM','block','builtin:bed',0,1,0,0,'#b03a3a',1,
'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAhElEQVR42mPY1BXzfyAxw4A7oCbC7P9A4oF3wAYrq/8g/O3rR7IwTD+5ePA44MWzB2ThUQcMPwecP7WXKDx8HNCno/N/IPHAO4DSIETHJ0JCwBhdHGYhzjQw6oBRB4w6YNQBA+aA0X7B7ALX/wOJB94BsMSQ5aWHgqmdOHGZP+qAAXcAAHO7XuhZrUeBAAAAAElFTkSuQmCC'
);
