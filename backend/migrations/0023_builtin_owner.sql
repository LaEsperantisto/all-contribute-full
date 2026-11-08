-- 0023: built-in content is owned by the admin account, not "SYSTEM".
--
-- Every published block/item stores the creator's name for display (the Studio
-- shows it in the card footer). Built-ins were stamped "SYSTEM"; the site has a
-- real admin account, so built-ins now credit that account instead. Nothing
-- gates on this string — ownership checks use creator_id, which stays NULL for
-- built-ins — so this is a display change only.
UPDATE blocks SET creator_name='admin' WHERE is_builtin=1;
UPDATE items SET creator_name='admin' WHERE is_builtin=1;
