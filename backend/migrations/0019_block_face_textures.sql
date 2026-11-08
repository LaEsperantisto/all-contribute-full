-- Per-face block textures: a cube can now carry its own picture for the upper
-- and lower faces, while "texture" stays the four sides. NULL means "same as the
-- sides", which is what every existing block already looked like — the columns
-- change nothing until a block names a face of its own.
--
-- Seeded: grass (green crown, dirt below, the soil-with-a-green-band picture is
-- a SIDE view) and wood (a log cut across the grain shows rings, bark
-- everywhere else).
ALTER TABLE blocks ADD COLUMN texture_top TEXT;
ALTER TABLE blocks ADD COLUMN texture_bottom TEXT;

UPDATE blocks SET texture_top = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAm0lEQVR42pVTsQ2AMAzLURwABzCwM3IAIz9wBocWpVKkYOxShojQOK7jgG3nXHIc11rwTGGWfSymitM61GgReNgfBUGYLzF1i2rGsC+AUhhP62nKzXlEzw0PcoO77BG5q0RMkyBGy2vDDX0S4N6piayAZjHMw8SYkanx3GtSQQa13plC6QHmzJ+6RmVej7mvD4nNzcaRBL2/c8bexSA7ZHPoOD8AAAAASUVORK5CYII=' WHERE id = 'builtin:grass';
UPDATE blocks SET texture_bottom = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAlklEQVR42pWTMQ6AMAhFOY+jo4ubk+5u7t7AS3jlGkww9PfT4MDQX3hAoXLtc/F2LGNBjdk2Da8JC2YQdfY6BfQqUF0DUE8DLCNqkuk3SvIBjHyfa+PMNF+lWLCKkTPqejZNMqNj9xWABbCRMZD0srKxhYDsBjYALM0/GLYSTuFv9grg9wAzs+1rWtCS8cH+VCS975oBPJX9Ao0LZO7JAAAAAElFTkSuQmCC' WHERE id = 'builtin:grass';
UPDATE blocks SET texture_top = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWUlEQVR42mPI8tL7TwlmABE1EWZk4UFqwKauGIKYoAGzC1yxYpBaZANAYjgNQLYRphkmDtOM4QKYAhiNHF3I4kR5YXAYgI6JMgBXDMAw3kCkSjoYmKRMCQYA7icfE18CnG0AAAAASUVORK5CYII=' WHERE id = 'builtin:wood';
UPDATE blocks SET texture_bottom = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWUlEQVR42mPI8tL7TwlmABE1EWZk4UFqwKauGIKYoAGzC1yxYpBaZANAYjgNQLYRphkmDtOM4QKYAhiNHF3I4kR5YXAYgI6JMgBXDMAw3kCkSjoYmKRMCQYA7icfE18CnG0AAAAASUVORK5CYII=' WHERE id = 'builtin:wood';
