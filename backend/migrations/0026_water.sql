-- Water and sea level: every column whose ground sits below
-- SEA_LEVEL (10) now fills up to it with builtin:water, and its surface cell
-- turns to builtin:sand (beaches). See backend/src/terrain.ts + the frontend
-- mirror in frontend/dve/src/world.js for the generation rule.
--
-- The textures follow the same recipe as migration 0016: 16x16 RGBA block
-- faces and a 32x32 item icon, hand-drawn from deterministic per-pixel noise
-- (xorshift on x,y,seed), packed as PNG with the plain zlib-deflate + CRC32
-- chunk recipe - no image tooling needed, the bytes are reproducible from the
-- pixel rules. Water carries alpha ~200 baked into the PNG; the mesher's
-- transparency path (the one glass and leaves already use, keyed by
-- behaviour:"transparent") renders it see-through.
--
-- Water has NO item row on purpose: it can never be placed by hand, and the
-- handleBreak no-item guard (dropId === current with no items row -> credit
-- nothing) keeps breaking it out of base terrain from leaking a phantom
-- "builtin:water" stack into anyone's inventory.

INSERT OR IGNORE INTO blocks
(id,name,creator_name,hardness,light,colour,behaviour,is_builtin,texture)
VALUES
('builtin:water','Water','SYSTEM',0.1,0,'#2b6fdb','transparent',1,
'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACVElEQVR42j1T61LSQRzd6l24yVVuT0CpmQ6m3xWVBBEDLzyDVmZj2aRDvYzICS0ghVIK8VNWk+V0GZ3RpjnH6MPO+l/PnttvMdaRTXQtHaPrwVd03n2HjjuvEFn4iHDuEIFsA91Lx4gsfoJ78g3C8y3cuP8F1+991vJO1WD82X04E2UB3JNV+NJ1AbkCM+/RmdlDcPaDCLl80291zssUMJbhDdjHSwjMNOCcKGvnt33spdyQ3JWs6H+2UcA6UoA3XZNbipqO+DYc8W2xESwHuUNYY0VEn50L5Jx4rUue1I4uupJVOOJbsIwUYELzLQF4MTR3oBj2sRKssU2RhOYPZJvK4VxL5MQH55rCmJuPTjCw/kfFsSCugfUL2EaLiCwcwZ/ZQ+/KT0TXLkTEst3JKuicAoY5PaldsEwWRwdUYmZGoitXooLgbFPlsR+64BnxKpFZSOIY3xKAYBLzm8X5pusi82f2JRSaa/6PYgbzRgUyK9X5LghyJcqwxYqyT+ucO8V4kRPi3vfkN4xnalcOeMh2mYvNe3k+vKG/24o8o1M6pJAcdD/8pjz8uPX4FwbzVzQiFtv/9ExRWGzvyg9NioLE3s4blWk4W5bRVuTLo2XOW8VlGypPrtI17bZ/LtmPYcttVpHlWrAMF9QDCUlGMJ+zuklWLotN1/UWDLOTkQ4IZiQqszROoX/1VDFYKidEkZ7lE/StnorEMD9JLl2U5UTK6bqI243TFd3xR+RlF6mdyw5oLbp2jsjiEXqWv2Po+VWVymdKsrbA0Itr2jluYkQ+XsJfIvc/ckr3ze8AAAAASUVORK5CYII=');

INSERT OR IGNORE INTO blocks
(id,name,creator_name,hardness,light,colour,behaviour,is_builtin,texture)
VALUES
('builtin:sand','Sand','SYSTEM',0.5,0,'#dacfa0','solid',1,
'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACKklEQVR42j2TeW8SURTF32c2Lq2NadRWv4BFCkULtAUTU6XutprGLhooDFDKNmxS2elnOOZ3ZfxjMsN9755z7rkH1y1salrfk5/bUKewqW4hoj+XL1U4XNPvYlTn71bU86L2jK4S+v76lubNtGaNPY2qSTmK1+UXBsDBcPG750XUvnhuFzv5sIpHTwxgUNnWqJowInpc14vYIUztfFjDq7gGl9vqFMJqZp8ZWL8Us29AJ/VdjWtJoZz7jiLMoCEb+cf7tzWp7WjWTBkTILD2S1sGMPfT8g7XbXTHAeiti5C9afKzGwYAGG8UjGs75sm0sacb/5WNRt3RQIFm5MN2mllWrxjVdTkmRqQ2MYAtA+GMOgQ2Ag4PK3EbA1Sk/vrwQGcH9+33z/crZmjAzj0UeYdrcrgK8qyR0tnBsqb1XVsnjvOgDHYYGZdG1tfO/9uQw8Dsp1Vjyn99bCtrLdgYjyYAPcvFlqnFPJTwuBs/rdznh4YME4fM5udCOsks2TcqeAMKCCMEYG5cTdoFGgNkVDEKdUZklYBj5qASl3e0blvjcQSID0vYVcLkw9CzmZM6eXtPx/t3DJTm7MdVi3Pp21MDdf1yzBoxKSiSMBQQrEAZKn68uftfFYFq5UJymMf+WSOsAFFDFeqCtQZRZgxMJQvzZkoOowgH+Wct+S+PhC+kEWO5CABZOM0sWT66iz8agA5kJMNk/8Ji1BwnF1xELnXAaMYLmOlhC38BxYRGdZ++uHsAAAAASUVORK5CYII=');

-- The held form of sand, so beaches can actually be dug and re-placed.
INSERT OR IGNORE INTO items
(id,name,creator_name,kind,place_block_id,damage,speed,heal,durability,colour,is_builtin,icon)
VALUES
('builtin:sand','Sand','SYSTEM','block','builtin:sand',0,1,0,0,'#dacfa0',1,
'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAB+ElEQVR42u2WSVICURBEObRnkVEZ3XkGj8DQTA1sZFRGj/CNl5As3NkNC42uiI7+E5VZWVW/yeUyyyyzzP6avbcfw35cD7w3g0r4GDxpvuqVwmHSCDcHfHt9kNPtqBpWUSms++XwNXsR6KZfCbtxTW/2OMMeazclgdND3AjHaTNAaNEt6FlHZUV+mrbCblQTMMSOk6ZI3QQcIECWvaJkhwTSA3Cata6EmJMCxvv4rA5kUoETGaDkGcfzTl5KQIAxCkBo2S1qDiiE+I3SFNelTmICRIS0i07h6pA3j2qiVxIYpD6Hz3og5TVS4Rr6tRG1AXDEnBwzB5wxzlHASqECJFyYBEDq8JOo3XACOApAAABLP2/nJT1jpeUiPwTIPWpth1XtJUoDjmk5onVOVd2DiiICgLn6Pz4XH3POK/q4cS3QRPcDMuLMsuIMQkRNRKyjCmPWVfmD831g6dlXq0YJUuBcIj8R4ZCCRA2ihhCOWfdZSBCx64Q2dfckvnZF4nLpuNAYs05aIGcC7BsQgpDjTKobkGLDmaS+FJyr3FcxxeY60cUVla6kOZ/6MiLvtBvSk1dXu7vEHeN6QX6rcrMvIA4BgwxEfBsis+uBdV/dqSP/aYBDAudEBjhvR8w+/U9HsHa3/wNUutqsWxSgv4TM7/J/ILPM/r19A0Kjicj1NchbAAAAAElFTkSuQmCC');
