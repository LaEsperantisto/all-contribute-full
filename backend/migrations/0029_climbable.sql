-- Climbable blocks + the ladder, and the bedrock honesty fix (0029).
--
-- blocks.climable: a registry flag for the engine climb rule. A climbable
-- block is also pass_through (a body may sit inside it), and while ANY part
-- of the body AABB overlaps such a cell, the engine skips gravity: W climbs
-- up at 2.2 m/s, letting go slides down at 2.4 m/s, jump works off the wall.
-- Water swim physics is deleted outright - "being in water" is not a special
-- state any more, it is just a non-solid block you fall through and sink in.
--
-- builtin:ladder ships with the flag set: dve_simple_thin_panel model (the
-- 3/16 panel already in the engine allow-list), transparent behaviour, and
-- textures from the same reproducible xorshift pixel recipe as 0016/0026/0027.
-- It is breakable (hardness 1) and drops itself.

ALTER TABLE blocks ADD COLUMN climbable INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO blocks
(id,name,creator_name,hardness,light,colour,behaviour,model,is_builtin,texture,pass_through,climbable,drop_item_id,drop_qty)
VALUES
('builtin:ladder','Ladder','SYSTEM',1,0,'#8a6a3f','transparent','dve_simple_thin_panel',1,
'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABSElEQVR42n2TV08DQQyE7x9RRYckdASIByAgen2ipkFCKAGe6U2A+K2DvtUtOml9rLRa6cYee8a+KIpPZaFNF+u9amwNKEo5lxt9utnJitgA5GNtuVPlfGsqATgk19uZMKY036KzlS4V55r1WhzVS2FEH5UJPR0N6W4vo/fyuE4W2131+mq3TQBAlbfSmO73s3o4yOnzdNK9X9Upna/1/JEEBIDVpQ4bTMgkjhuAtH+7m3NG/ucB+k2fIAAkKI2ACXmvTHaY0YiJmMdF+099xvkCdrXZr8JsU0hAMjMmgKTv2rRz/vFw0BFiKh4xRl7TREBzRIlJUcA0EQmYaOqLjzfZnBSVSaZCGgHJkJgSaI8pQMQWctGPdjbx+XjYkfuFMyUwJlaZFYYA9zGSbcRUEqlOFwGBN8f8UeIDRgfmInnA1JfwibhkzC/qVxeUqIs9wQAAAABJRU5ErkJggg==',1,1,'builtin:ladder',1);

-- The held form: place one, break it back, craft it from sticks.
INSERT OR IGNORE INTO items
(id,name,creator_name,kind,place_block_id,damage,speed,heal,durability,colour,is_builtin,icon)
VALUES
('builtin:ladder','Ladder','SYSTEM','block','builtin:ladder',0,1,0,0,'#8a6a3f',1,
'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAC7klEQVR42p3XVY8cQQwE4PtHYYa7CzMozPwUvBxT8DnM/FMn+lqqaCMl0npWsqZnZ9xdLrurPSMj//g9ub69e3hyZff0xmizyVOrupHi79nNsW75ypZmc+fXd4+vbRt+Di9znD23rps6vbqbObu2DGDx0qYGXDDTZ9Z0z2+NDz/Ho6tbmyMgrA8DS5c3N/bmL2zogCkBQD/UCxc3NgaAqQJAu0UTCEClFEAfEK5fZg92n6b3d9/mD3efZw50L++Mda/v7Wj3L26Pdm/u72z37MPk3ha5OuDPjEsA5B169Ivm7YNdDcD3hSNtAQbUj8WjDcy7id3tP0AYH6nEQuYbGoDoOUkF6tjPpWMNBADvH+5p91/nDrV7/3+c2vfXMwww7AnCnKUaEL0ITGBHVGuAf7ZxQAztzIFjJpHDPjpgnhRxqZAtiIUISZ9dIGK+Umm+MgBFA72JpKIKIApIzLBRAhD5RSFnQlIFgEEBAMDfeGjniRMr/hSPKFgVgAVTBxgs6QAHKWCA9DkLgEa7LZx6GNrZgmiLs7G9TWjs91/Lx5sA0QEixGjBq7vj7ZkxARJ1UikVJfTMBKgEgMRa3GKuVDFCRJqpn2ukmr8ALM5KZ4GXqZjdgDrRWFRkkVuLUz3AyHBAee5Z+gngATBfqQYix8alZmJACbOLWEmKoRU5JykQTR8lxFyKubQNvcySij4Nia0MgDkwWCpCkWMgAEroB3aS9KU1KwHgmCKUy5LzQE/ITxCCKcm5iEMbKvuchuawcLZhKY05QCweSa0CiJSnOS0FkU5WHkOhvc70f8SGBkR8jKkgnUjviEFFmB1VZsDiHHMkR3gIjUXTovmfCHnmCggQfDEYLSgxwJlTvgs4pym1EAaMo4LOBcC847lnAhC9Is6WHhoA6vJNkGqu1kDa8cFzpbSF8kHh2qcfyLeFNEhhqQZQFyEx7sNAegq+ma/UFacbCgtVAPkuMAcmSt+GUKczTiH2UUKFl3Plfyz+BrmLi6sTO/MmAAAAAElFTkSuQmCC');

-- Bedrock told a lie in the registry: hardness 0. The mining rule (break
-- refusal at hardness >= 500, infinite client bar) needs the truth first.
UPDATE blocks SET hardness=600 WHERE id='builtin:bedrock';
