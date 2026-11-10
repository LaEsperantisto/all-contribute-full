// Deterministic Minecraft-style base terrain. The frontend mirrors these
// functions verbatim (frontend/dve/src/world.js). Changing them changes the
// world: existing 'air' edits and player expectations shift — bump a world
// version marker before shipping such a change.
//
// Coordinate convention (world model v2): y GROWS UPWARD, y=0 is the bedrock
// floor, air above. Each (x, z) column comes from a height field plus
// deterministic trees and caves — identical in the Worker and the browser.

export const WORLD_Y = 64; // legal solid band is y ∈ [0, 63]
export const SEA_LEVEL = 10; // columns with heightAt < this flood up to y=SEA_LEVEL

function hashU32(n: number): number {
  n = (n | 0) ^ 0x9e3779b9;
  n = Math.imul(n, 0x85ebca6b);
  n ^= n >>> 13;
  n = Math.imul(n, 0xc2b2ae35);
  n ^= n >>> 16;
  return n >>> 0;
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

// Bilinear value noise on a lattice of side s. Lattice values are in [0,15];
// interpolation weights are integer eighths — small exact integer arithmetic,
// and the single division by a power of two keeps Worker and browser in
// bit-identical agreement.
function noise2(x: number, z: number, s: number): number {
  const gx = Math.floor(x / s);
  const gz = Math.floor(z / s);
  const wx = Math.floor((mod(x, s) * 8) / s);
  const wz = Math.floor((mod(z, s) * 8) / s);
  const c = (ix: number, iz: number) =>
    hashU32((ix * 0x27d4eb2d) ^ (iz * 0x165667b1) ^ 0x51ed2701) % 16;
  const a = c(gx, gz) * (8 - wx) * (8 - wz);
  const b = c(gx + 1, gz) * wx * (8 - wz);
  const d = c(gx, gz + 1) * (8 - wx) * wz;
  const e = c(gx + 1, gz + 1) * wx * wz;
  return (a + b + d + e) / 64;
}

// Surface height: plains/forest keep the original 6..21 field; deserts
// flatten onto the shore band; mountains climb to ~30 — still well under the
// y=63 build ceiling (margin kept on purpose).
export function heightAt(x: number, z: number): number {
  const sum =
    6 * noise2(x, z, 24) +
    3 * noise2(x, z, 12) +
    2 * noise2(x, z, 6) +
    noise2(x, z, 3);
  const h0 = 6 + Math.floor(sum / 12);
  const bi = biomeAt(x, z);
  if (bi === "mountain") return h0 + 4 + Math.floor(noise2(x, z, 9) / 3);
  if (bi === "desert") return Math.max(SEA_LEVEL - 1, Math.min(SEA_LEVEL + 4, h0));
  return h0;
}

// Biomes from one low-frequency field (0..~22.5). Thresholds are locked by
// the parity stage — never retune them without re-running s28terrain.
export type Biome = "desert" | "plains" | "forest" | "mountain";

export function biomeAt(x: number, z: number): Biome {
  // Spawn meadow: the 24-cell ring around the origin is always plains, so
  // no world ever spawns buried in mountain stone (every other structure
  // gate stays biome-driven). Mirror of frontend/dve/src/world.js.
  if (x * x + z * z <= 576) return "plains";
  const b = noise2(x, z, 96) + noise2(x, z, 32) / 2;
  return b < 6 ? "desert" : b < 12 ? "plains" : b < 16 ? "forest" : "mountain";
}

// Sparse deterministic trees, thinned by biome: forest ~1/12, plains ~1/40,
// mountain ~1/80, desert none. The hash inputs stay identical (only the
// modulus changes) so plains trees keep their old columns.
function hasTree(x: number, z: number): boolean {
  const bi = biomeAt(x, z);
  if (bi === "desert") return false;
  const m = bi === "forest" ? 12 : bi === "mountain" ? 80 : 40;
  return hashU32((x * 0x9e3779b1) ^ (z * 0x85ebca77) ^ 0x2545f491) % m === 0;
}

// --- Structures -------------------------------------------------------------
// One chunk (16 cells) holds nothing, a village, a pyramid, or a mountain
// arch. structureAt is PURE per-cell: membership is recomputed from the
// chunk's PRNG stream on every call, so sector order never matters, the
// twins diff trivially, and a chunk with nothing costs one hash.
const CHUNK = 16;

const structureHash = (cx: number, cz: number) =>
  hashU32((cx * 0x9e3779b1) ^ (cz * 0x85ebca6b) ^ 0x1f2e3d4c);

const vrand = (salt: number, i: number) => hashU32(salt + i * 0x27d4eb2d);

function structureAt(x: number, y: number, z: number): string | null {
  const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
  switch (structureKind(cx, cz)) {
    case "village": return villageAt(x, y, z, cx, cz);
    case "pyramid": return pyramidAt(x, y, z, cx, cz);
    case "arch": return archAt(x, y, z, cx, cz);
  }
  return null;
}

// Which structure (if any) owns a chunk — exported so proof stages can scan
// for villages/pyramids/arches instead of duplicating the gate formulas.
export function structureKind(cx: number, cz: number): "village" | "pyramid" | "arch" | null {
  if (cx === 0 && cz === 0) return null; // spawn clearing: nothing on the first chunk
  const sh = structureHash(cx, cz);
  const gx = cx * CHUNK + 8, gz = cz * CHUNK + 8;
  const bi = biomeAt(gx, gz);
  if (bi === "plains" && sh % 64 === 0 && heightAt(gx, gz) > SEA_LEVEL) return "village";
  if (bi === "desert" && sh % 48 === 0) return "pyramid";
  if (bi === "mountain" && sh % 32 === 0) return "arch";
  return null;
}

// Village: 3-5 planked houses on the chunk-centre ground hg, plus a stone
// well with a water column. Terrain-conforming: walls/floor fill dirt where
// the ground falls below hg (disclosed quirk: partial embedding on slopes).
function villageAt(x: number, y: number, z: number, cx: number, cz: number): string | null {
  const salt = hashU32(cx ^ (cz * 0x9e3779b1) ^ 0x77);
  const hg = heightAt(cx * CHUNK + 8, cz * CHUNK + 8);
  const dx0 = x - (cx * CHUNK + 8), dz0 = z - (cz * CHUNK + 8);
  if (Math.abs(dx0) <= 1 && Math.abs(dz0) <= 1 && !(dx0 === 0 && dz0 === 0) && (y === hg || y === hg - 1))
    return "builtin:stone"; // well ring
  if (dx0 === 0 && dz0 === 0 && y === hg) return "builtin:water"; // well column
  const houses = 3 + vrand(salt, 0) % 3;
  for (let i = 0; i < houses; i++) {
    const side = 5 + (vrand(salt, 1 + i) % 2) * 2; // 5 or 7
    const ox = 1 + vrand(salt, 2 + i) % (CHUNK - side - 1);
    const oz = 1 + vrand(salt, 4 + i) % (CHUNK - side - 1);
    const dx = x - (cx * CHUNK + ox), dz = z - (cz * CHUNK + oz);
    if (dx < 0 || dz < 0 || dx >= side || dz >= side) continue;
    const perim = dx === 0 || dz === 0 || dx === side - 1 || dz === side - 1;
    const corner = (dx === 0 || dx === side - 1) && (dz === 0 || dz === side - 1);
    if (y === hg + 3) return "builtin:wood"; // flat roof
    if (y === hg - 1) return "builtin:dirt"; // floor slab
    if (perim && y < hg - 1 && y > heightAt(x, z)) return "builtin:dirt"; // footing
    if (y >= hg && y <= hg + 2 && perim) {
      if (corner) return "builtin:wood";
      const sideIdx = dz === 0 ? 0 : dx === side - 1 ? 1 : dz === side - 1 ? 2 : 3;
      const along = sideIdx % 2 === 0 ? dx : dz;
      if (sideIdx === vrand(salt, 6 + i) % 4 && y === hg &&
        along === 1 + vrand(salt, 7 + i) % (side - 2))
        return "air"; // stream-picked door
      if ((sideIdx === 0 || sideIdx === 2) && y === hg + 2 && along >= 1 && along <= side - 2)
        return "builtin:glass"; // long-side windows at wall-base+2
      return "builtin:planks";
    }
    if (!perim && y > hg - 1 && y < hg + 3) return "air"; // interior
    return null;
  }
  return null;
}

// Pyramid: sand ziggurat in the desert, hollow core, one carved entrance,
// glowstone at the apex (the registry's glowing behaviour makes it lit).
function pyramidAt(x: number, y: number, z: number, cx: number, cz: number): string | null {
  const salt = hashU32(cx ^ (cz * 0x9e3779b1) ^ 0x33);
  const r = 4 + salt % 3; // half-side: base 9/11/13
  const dx = x - (cx * CHUNK + 8), dz = z - (cz * CHUNK + 8);
  const adx = Math.abs(dx), adz = Math.abs(dz);
  const m = Math.max(adx, adz);
  if (m > r) return null;
  const ground = heightAt(cx * CHUNK + 8, cz * CHUNK + 8);
  const top = ground + (r - m);
  if (y <= ground || y > top) return null;
  const axis = salt % 2, sign = (vrand(salt, 1) % 2) * 2 - 1;
  const entrance = (axis === 0 ? Math.abs(dz) === r && adx <= 1 : adx === r && adz <= 1) &&
    (axis === 0 ? Math.sign(dz) : Math.sign(dx)) === sign &&
    y >= ground + 1 && y <= Math.min(ground + 2, top);
  if (entrance) return "air";
  if (m <= r - 2 && y <= ground + 3) return "air"; // hollow core
  if (dx === 0 && dz === 0 && y === top) return "builtin:glowstone";
  return "builtin:sand";
}

// Mountain arch: two legs and a lintel, interior air — visible proof that
// mountains get built things.
function archAt(x: number, y: number, z: number, cx: number, cz: number): string | null {
  const hg = heightAt(cx * CHUNK + 8, cz * CHUNK + 8);
  const dx = x - (cx * CHUNK + 8), dz = z - (cz * CHUNK + 8);
  if (dz !== 0) return null;
  if (Math.abs(dx) === 2 && (y === hg + 1 || y === hg + 2)) return "builtin:stone";
  if (Math.abs(dx) <= 2 && y === hg + 3) return "builtin:stone";
  return null;
}

// Trilinear value noise (side 8); caves carve where the field peaks.
function caveAt(x: number, y: number, z: number): boolean {
  const s = 8;
  const gx = Math.floor(x / s);
  const gy = Math.floor(y / s);
  const gz = Math.floor(z / s);
  const wx = mod(x, s), wy = mod(y, s), wz = mod(z, s);
  const c = (ix: number, iy: number, iz: number) =>
    hashU32((ix * 0x1b873593) ^ (iy * 0xcc9e2d51) ^ (iz * 0x165667b1) ^ 0x9e3779b3) % 16;
  const n =
    c(gx, gy, gz) * (8 - wx) * (8 - wy) * (8 - wz) +
    c(gx + 1, gy, gz) * wx * (8 - wy) * (8 - wz) +
    c(gx, gy + 1, gz) * (8 - wx) * wy * (8 - wz) +
    c(gx + 1, gy + 1, gz) * wx * wy * (8 - wz) +
    c(gx, gy, gz + 1) * (8 - wx) * (8 - wy) * wz +
    c(gx + 1, gy, gz + 1) * wx * (8 - wy) * wz +
    c(gx, gy + 1, gz + 1) * (8 - wx) * wy * wz +
    c(gx + 1, gy + 1, gz + 1) * wx * wy * wz;
  return n / 512 > 11;
}

// The full column rule. Order matters: bedrock, structures (they win),
// caves, layers, then trees.
export function baseBlock(x: number, y: number, z: number): string {
  if (y < 0 || y >= WORLD_Y) return "air";
  if (y === 0) return "builtin:bedrock";
  const st = structureAt(x, y, z);
  if (st !== null) return st;
  const h = heightAt(x, z);
  if (y > h) {
    // Sea: flooded columns fill with still water up to SEA_LEVEL. The sea is
    // static — no flow simulation. Trees never sit in the sea (gated below),
    // so a flooded column is pure water over its floor.
    if (h < SEA_LEVEL && y <= SEA_LEVEL) return "builtin:water";
    if (h >= SEA_LEVEL && hasTree(x, z) && y <= h + 5) return "builtin:wood"; // trunk
    // The crown sits on top of the trunk: the point that used to be empty
    // directly above the trunk is now two leaves of crown, one level higher
    // than the old canopy top.
    if (h >= SEA_LEVEL && hasTree(x, z) && (y === h + 6 || y === h + 7)) return "builtin:leaves";
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dz === 0) continue;
        if (Math.abs(dx) + Math.abs(dz) > 2) continue;
        if (!hasTree(x + dx, z + dz)) continue;
        const h2 = heightAt(x + dx, z + dz);
        if (h2 < SEA_LEVEL) continue; // no canopy over the sea
        if (y >= h2 + 4 && y <= h2 + 6) return "builtin:leaves";
      }
    }
    return "air";
  }
  if (y < h && caveAt(x, y, z) && y > 1) return "air";
  const bi = biomeAt(x, z);
  if (y === h) {
    if (h < SEA_LEVEL) return "builtin:sand"; // beaches
    if (bi === "desert") return "builtin:sand"; // dunes
    if (bi === "mountain") return "builtin:stone"; // rocky caps
    return "builtin:grass";
  }
  if (bi === "mountain" && y < h - 1) return "builtin:stone"; // thin dirt band only
  if (y >= h - 3) return "builtin:dirt";
  return "builtin:stone";
}
