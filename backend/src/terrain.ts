// Deterministic Minecraft-style base terrain. The frontend mirrors these
// functions verbatim (frontend/dve/src/world.js). Changing them changes the
// world: existing 'air' edits and player expectations shift — bump a world
// version marker before shipping such a change.
//
// Coordinate convention (world model v2): y GROWS UPWARD, y=0 is the bedrock
// floor, air above. Each (x, z) column comes from a height field plus
// deterministic trees and caves — identical in the Worker and the browser.

export const WORLD_Y = 32; // legal solid band is y ∈ [0, 31]

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

// Surface height 6..21, four octaves (integer combination, floored once).
export function heightAt(x: number, z: number): number {
  const sum =
    6 * noise2(x, z, 24) +
    3 * noise2(x, z, 12) +
    2 * noise2(x, z, 6) +
    noise2(x, z, 3);
  return 6 + Math.floor(sum / 12);
}

// Sparse deterministic trees: about one per 40 columns.
function hasTree(x: number, z: number): boolean {
  return hashU32((x * 0x9e3779b1) ^ (z * 0x85ebca77) ^ 0x2545f491) % 40 === 0;
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

// The full column rule. Order matters: bedrock, caves, layers, then trees.
export function baseBlock(x: number, y: number, z: number): string {
  if (y < 0 || y >= WORLD_Y) return "air";
  if (y === 0) return "builtin:bedrock";
  const h = heightAt(x, z);
  if (y > h) {
    if (hasTree(x, z) && y <= h + 4) return "builtin:wood"; // trunk
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dz === 0) continue;
        if (Math.abs(dx) + Math.abs(dz) > 2) continue;
        if (!hasTree(x + dx, z + dz)) continue;
        const h2 = heightAt(x + dx, z + dz);
        if (y >= h2 + 3 && y <= h2 + 5) return "builtin:leaves";
      }
    }
    return "air";
  }
  if (y < h && caveAt(x, y, z) && y > 1) return "air";
  if (y === h) return "builtin:grass";
  if (y >= h - 3) return "builtin:dirt";
  return "builtin:stone";
}
