-- Player block IDs become namespace-scoped: player:USERNAME:NAMESPACE:BLOCKNAME
-- (like builtins' builtin:NAME plus a separate display name in `name`).
-- Existing 3-segment IDs (player:user:block) gain the 'default' namespace.
UPDATE blocks
SET id = 'player:' || substr(substr(id,8),1,instr(substr(id,8),':')-1)
         || ':default:' || substr(substr(id,8),instr(substr(id,8),':')+1)
WHERE id LIKE 'player:%' AND (length(id)-length(replace(id,':',''))) = 2;

UPDATE inventories
SET item_id = 'player:' || substr(substr(item_id,8),1,instr(substr(item_id,8),':')-1)
              || ':default:' || substr(substr(item_id,8),instr(substr(item_id,8),':')+1)
WHERE item_id LIKE 'player:%' AND (length(item_id)-length(replace(item_id,':',''))) = 2;

UPDATE world_edits
SET block_id = 'player:' || substr(substr(block_id,8),1,instr(substr(block_id,8),':')-1)
               || ':default:' || substr(substr(block_id,8),instr(substr(block_id,8),':')+1)
WHERE block_id LIKE 'player:%' AND (length(block_id)-length(replace(block_id,':',''))) = 2;
