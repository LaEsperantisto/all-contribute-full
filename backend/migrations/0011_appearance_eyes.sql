-- Eyes: the avatar gains a fourth customisable colour, drawn on the head so
-- other players can read which way you are facing (0011). Existing rows keep
-- the default ink eye colour.
ALTER TABLE player_appearance ADD COLUMN eye_colour TEXT NOT NULL DEFAULT '#1d2430';
