// Deterministic base terrain. The frontend mirrors these functions verbatim
// (frontend/app.js, "Base terrain" section). Changing them changes the world:
// existing 'air' edits and player expectations shift — bump a world version
// marker before shipping such a change.

function hashU32(n: number): number {
  n = (n | 0) ^ 0x9e3779b9;
  n = Math.imul(n, 0x85ebca6b);
  n ^= n >>> 13;
  n = Math.imul(n, 0xc2b2ae35);
  n ^= n >>> 16;
  return n >>> 0;
}

export function terrainHeight(x: number): number {
  // Plateaus 4 tiles wide; integer ops only so server and browser agree exactly.
  return 10 + (hashU32(Math.floor(x / 4) ^ 0x51ed2701) % 6);
}

// Y grows downward. Air above the surface; grass, then dirt, then stone.
export function baseBlock(x: number, y: number): string {
  const h = terrainHeight(x);
  if (y < h) return "air";
  if (y === h) return "builtin:grass";
  if (y <= h + 3) return "builtin:dirt";
  return "builtin:stone";
}
