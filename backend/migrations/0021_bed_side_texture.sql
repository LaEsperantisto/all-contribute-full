-- The bed's side, redrawn. The old picture filled the whole face with cover,
-- which read as a red wall with a pillow stuck to it. A bed seen from the side
-- is an object, so the face now has a silhouette: a tall headboard at the head
-- end, a shorter footboard at the foot, the mattress edge-on between them with
-- the cover draped over the edge, the frame rail and legs underneath, and the
-- space above the mattress left as the dark gap you look over. The item icon is
-- the same picture enlarged, so the bag and the block agree.
UPDATE blocks SET texture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAi0lEQVR42mPY1BXzHxlLyiiRhBlqIszAGkF0lpfeqAFeev+/ff2IgdE1IQc6hgHnT+39/+LZAxSMbgBILUw9igHYbMeFsRqAbjM+jGIADJ8ICcGL+3R0wBjEhhuA7LcNVlZwDFKIzoYZAGJTbAA8GkHE7AJXsjDcAORwIAXDDQBhkH+ISYno6ig2AABKAgQ3bVGA7gAAAABJRU5ErkJggg==' WHERE id = 'builtin:bed';
UPDATE items SET icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAp0lEQVR42mPY1BXzHx+WlFGiKWYYcAfURJj9B2GYhTB+lpceGI86YNQBow4YdcC3rx+JwoQswlXQDX4HnD+1F4xfPHuAFxNyAMxcdPMHrwOIDXpS8dBxAKEgJxcPXgeg4xMhIRThPh0dFAwTH3wOwJVtNlhZYcUwAwmJozsAJj7qAIzKaNA4YHaBK13x4HMAruxIKzz4HADDsOxBrSYZIfNGHTDgDgAA60IQ2TwihYAAAAAASUVORK5CYII=' WHERE id = 'builtin:bed';
