-- Farmland and wheat: the first crops. Placing builtin:farmland (item mirror
-- below) gives soil; the wheat_seed item places builtin:wheat_1 on any solid
-- surface, and the WorldLive alarm (stepCrops) advances standing wheat one
-- stage every ~20 s up to builtin:wheat_4. Harvest uses Feature 1's declared
-- drops: stages 1-3 yield one wheat_seed (so replanting is free), stage 4
-- yields two wheat. Simplification disclosed up front: there is no hoe and no
-- tilling - farmland is placed directly - and wheat_1 stands on any solid
-- cell, not only farmland.
--
-- Wheat stages use the existing dve_simple_crossed_panels model (two crossed
-- quads), so no renderer geometry work: the textures carry the growth shape
-- on a transparent field. Textures follow the 0016/0026 PNG recipe.

INSERT OR IGNORE INTO blocks
(id,name,creator_name,hardness,light,colour,behaviour,is_builtin,texture)
VALUES
('builtin:farmland','Farmland','SYSTEM',0.4,0,'#6b4a2e','solid',1,
'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACD0lEQVR42kWTW1PaYBCGv5+igmhvxEASDgGnvVMIEMA6qGg77U2lilIV7+qJVmc6/c1v51kSe7Gz+fb8vrtx005JN/1AP3q+Ltqevu1u6WyvKOzYrrpl3fZDzYcV3Q5CzQehLjslnbe3dd725Pgg8Xtr22SyVzRNclZ0Gi8TKDDr+dbwblgxcQ9HNXO+nDYtYTGO9Hwc6eeoqsVJQ9dJoD9f3pvv8ahusUzJJPhcv5IXMqyum/5Y39Cguq7D5jv1wpzpt5hawfyt0oq90Y7KYGI8KtOBysBAT2NP80FFZ7tbxkcm+C9iT+6mH9oD0kig4NzI+p8ED+Be8lQ0Ab8VyDD+Pm1aAXD/OmkYWdheP+/oflTV03Fk28H28mnnbUp3EG2oG+TUC3KGEWzg7gZr9p2EeXX8NXuPGpvarxVEDpzBkWPHGSa4sBuIPYNyl+6e8Q1e4ttK4SqD6kggaGKJJdOT1vKQeJNMDEIjkonnm4bu/rBmj79fP2jWLVt3kh5SO50v02uFVG6ESRbjht2FAxdYwciOwcYdwAc2MGM7iDaND2L36wW7gdhflQMnY8EBzHMH83REcGYnzhSsj5XyzbSs2l0nvmFidBxXqQNbtn+aoOGH4hSmKTbHMRDA7l/T/eKcpT8T3FCYos/jSNnhkcwUDlzgQZIwZxoO2H1SySsur6pdWrE7gS9ugDi+4ewfOFPjZvatv48AAAAASUVORK5CYII=');

INSERT OR IGNORE INTO blocks
(id,name,creator_name,hardness,light,colour,behaviour,model,is_builtin,texture,drop_item_id,drop_qty)
VALUES
('builtin:wheat_1','Wheat (stage 1)','SYSTEM',0,0,'#64a04f','transparent','dve_simple_crossed_panels',1,'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR42mNgGAWjAAfwmObwH4SJFSdaEcUGUGzIqBewywEAvcVDoY6qQ5gAAAAASUVORK5CYII=','wheat_seed',1),
('builtin:wheat_2','Wheat (stage 2)','SYSTEM',0,0,'#7aa84f','transparent','dve_simple_crossed_panels',1,'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAASUlEQVR42mNgGAXUB9OOJPwHYY9pDv9xyRHUjE0hPjk4SFgTgFcBPtehAJACbIpwiaO4AJcifHIk2UK2K6jiAorCgCquoEksAAC6l4ielWa6IwAAAABJRU5ErkJggg==','wheat_seed',1),
('builtin:wheat_3','Wheat (stage 3)','SYSTEM',0,0,'#b8a84f','transparent','dve_simple_crossed_panels',1,'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAVElEQVR42mNgGH7g0YmE/yBMqhyKAmwK8clhNWTPEqf/57bFwBWC2DA5ZHHquoCQLbhchwFACkCYWHEUF8AUoduAT44kW8h2BVVcQFEYUMUVNIkFAFl47Yky20orAAAAAElFTkSuQmCC','wheat_seed',1),
('builtin:wheat_4','Wheat (ripe)','SYSTEM',0,0,'#d9c05f','transparent','dve_simple_crossed_panels',1,'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIElEQVR42mNgQALvrlX8h2EGNIBPjnoGjIJRMAoGEAAAsismxewgZqAAAAAASUVORK5CYII=','wheat',2);

INSERT OR IGNORE INTO items
(id,name,creator_name,kind,place_block_id,damage,speed,heal,durability,colour,is_builtin,icon)
VALUES
('builtin:farmland','Farmland','SYSTEM','block','builtin:farmland',0,1,0,0,'#6b4a2e',1,
'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADWElEQVR42u2W2VLjQAxF+RiWkLyRzWEJfwDZCZD5BxwSJoHw7Zo6al3jmRf7feIql3uR1Vqurvrk5Pgcn+Pzz/M+6tj6sW3bSdc24459Pw3sY9K1wyKz/axvn/O+r/Ei9z5q227as8NiYF+LzNfzxyvbjDp2CLn84crQux13rNIADtiOu66AAziU+ec8s7eHK1fInPFu1rP8se0GMudlzD+/pz3/H3157GFspQFSIs/xRh6zR2RQjNccgmGMMUqGSJao4LmM4a004Nd9y16HTXu6adi4d2qrYZpPs3Ob9M/s+fbSlrcNmw3SfHXfctnXuyQzZm3YsuXtpS2uL+zl7tKWNw2XRU+lAbIWy8lpHmngxaON57LrkcB74aRISURgP+8XKUHPbtb3aFYa4Hmf94twClgpzB1XwiEyVIesRynf+od94YUx6zhRaQBCyi8/o5gD8ZyD8BIZDmGfQwCX/1eKAP9jLAcTJaLH/5UGHKKMHGizfpEOvOclOttAOgeqaoR2ylVRQxeHqwqQqQXCUe/UgcU4AarhgJpmZ/5lnZe5y9y3bD44dzmB9OWu6aDTeJKduc5KA3L3/KfEVIKEcO9AagchZUW54uk2MKOws44MKRRp1QIhIUuIT6FkLJS/BfiEcMYY8TFJKdiMOwUfMHd2nGdF1aCnGgOLgUcAZTogDwKS56LljyhFr4zwXMzIXKXLHF0AuUYvSCynEluHQqVDnn9FhDAUkCpVzJHfev9IfAB40cN/lQbMry8cLDDYKsAGwMRo7K2CLWHDBNSm7zN+ju+rrzUd0LAgY9YrDXDWggMCVHi0C/CpE+JZ7mWVFayHjBpOuQOWm9h7nRTsovsRNgDkuQs8oGAflJoHAx5KhwnAuSO+HWTULsJfywApFSMCHOVYFLuL3pCQniUSijuEd8cgKFWGl2DgqdIA97zE5aLVcovWPeGHcuPeEHsyVvspbZkbUWnALFoqwFneJBZ7iu9ztFiAyr4DctgqgAbwmAO2slxqy03XWysF35GC1Bfaf3U9AKjy1M0HEKoslb4yWZUvL7XuAyhaB5BSS00gPEQo2XfQxW1HZFNOl8CrqhEeajBh9sPdXDICiGq9yi35Zi0vXTpUsup8gFH3gATKGhE4Pv/d8weJLgJiOHywbQAAAABJRU5ErkJggg=='),
('wheat_seed','Wheat Seed','SYSTEM','block','builtin:wheat_1',0,1,0,0,'#c8bc78',1,
'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABOElEQVR42u2V21LCQBBE+UQ/x3ARVC5BffZrCBe5JZtEUAEBP2asM9ZaPFPZt+mqrZnsQ7p7trOp1QwGg8FwBb6zgWze2vK1epRTPpR80pBD1pfgxMWkKR+Le0FAOroVnt24rmLYy0aR7NNeOCE4LacteX25kZ/yWc7FkxJu5m05l389ooKQ45xxQ5olkY6dKajzJNKeult1VVzlArbzjrzP7oQK+efyQcXQU1nbRUcOaV/ycaN6AQTu6GJdkDONYtoUl9Q1BwgjA15o5QI0aG4g5aylAnB5KoayX/c0Ewj0gQxyBJwvL96tu0qKU8bO58ceonBOTx4qF4DzYx7/hw7X9Cz2yQICIScHQb4EiL1zT4hzSOn9BRXsHsCZHzvVh5Gqk3CxTif4jXh59pe3o/2kDAaD4Rr8AhbrfazAUo6kAAAAAElFTkSuQmCC'),
('wheat','Wheat','SYSTEM','food',NULL,0,1,2,0,'#e0c860',1,
'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAQUlEQVR42mNgGAWjYBQQAZ6dSfgPw5SIU+wIaoiPhsBoCIyGwNANgX3L3P5TQ3zUAaMOGHXAqANGHTAKRsEoQAcA4NAGohRGItkAAAAASUVORK5CYII=');

-- Placement rules (rules_json): crops stand ON soil/solid, never float.
UPDATE blocks SET rules_json='{"support":"solid","incompatibleWith":[]}'
WHERE id IN ('builtin:farmland','builtin:wheat_1','builtin:wheat_2','builtin:wheat_3','builtin:wheat_4');
