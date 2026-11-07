import { DurableObject } from "cloudflare:workers";
import { baseBlock, WORLD_Y } from "./terrain";

export interface Env {
  DB: D1Database;
  WORLD_LIVE: DurableObjectNamespace;
}

type User = { id: string; username: string };
type AuthenticatedSession = { user: User; sessionId: string; tokenHash: string };
type SessionRow = {
  id: string;
  username: string;
  session_id: string;
  expires_at: number;
  idle_expires_at: number;
  last_seen_at: number;
};

const COOKIE_NAME = "__Host-ac_session";
const DAY_MS = 24 * 60 * 60 * 1000;
const IDLE_TIMEOUT_MS = 7 * DAY_MS;
const ABSOLUTE_TIMEOUT_MS = 30 * DAY_MS;
// Touch at most once every 15 minutes to avoid a D1 write on every API request.
const SESSION_TOUCH_INTERVAL_MS = 15 * 60 * 1000;

// Live fan-out for the shared world: keeps connected players' WebSockets and
// broadcasts each world edit. No hibernation (free tier): sockets live in
// memory; clients reconnect after eviction and the sequence-numbered polling
// fallback (world_log) fills any gaps, so delivery is best-effort but never
// leaves a client permanently stale.
export class WorldLive extends DurableObject<Env> {
  sockets: WebSocket[] = [];
  // Presence: socket -> current pose, so joining players see a roster and
  // everyone gets periodic pose fan-out (~5 Hz, client-throttled).
  presence: Map<WebSocket, { name: string; x: number; y: number; z: number; yaw: number }> = new Map();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/publish") {
      const message = await request.json().catch(() => null);
      if (message) this.broadcast(message);
      return new Response("ok");
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.push(server);
      server.addEventListener("message", (event) => this.onMessage(server, event.data));
      server.addEventListener("close", () => {
        this.sockets = this.sockets.filter((socket) => socket !== server);
        const name = this.nameOf(server);
        if (this.presence.delete(server) && name) {
          this.sendOthers(server, { type: "leave", name });
        }
      });
      server.send(JSON.stringify({
        type: "roster",
        players: [...this.presence.values()],
      }));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Expected a WebSocket upgrade.", { status: 426 });
  }

  private nameOf(socket: WebSocket): string {
    return this.presence.get(socket)?.name || "";
  }

  private onMessage(socket: WebSocket, data: string | ArrayBuffer): void {
    if (typeof data !== "string") return;
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "who") {
      socket.send(JSON.stringify({ type: "roster", players: [...this.presence.values()] }));
    } else if (msg.type === "pose") {
      const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
      const name = String(msg.name || "").slice(0, 32) || this.nameOf(socket) || "someone";
      const entry = { name, x: num(msg.x), y: num(msg.y), z: num(msg.z), yaw: num(msg.yaw) };
      this.presence.set(socket, entry);
      this.sendOthers(socket, { type: "pose", ...entry });
    }
  }

  private sendOthers(from: WebSocket, message: unknown): void {
    const data = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket === from) continue;
      try {
        socket.send(data);
      } catch {
        // Pruned by the close listener.
      }
    }
  }

  broadcast(message: unknown): void {
    const data = JSON.stringify(message);
    for (const socket of this.sockets) {
      try {
        socket.send(data);
      } catch {
        // Dead sockets are pruned by their close listener.
      }
    }
  }
}

function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    const isGitHubPages = parsed.protocol === "https:" &&
      parsed.hostname.endsWith(".github.io") && !parsed.port;
    const isLocalDev = parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    return isGitHubPages || isLocalDev ? parsed.origin : null;
  } catch {
    return null;
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  const acceptedOrigin = allowedOrigin(origin);
  if (!acceptedOrigin) return { "Vary": "Origin" };
  return {
    "Access-Control-Allow-Origin": acceptedOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-AC-Request",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(
  data: unknown,
  status = 200,
  origin: string | null = null,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
      ...extraHeaders
    }
  });
}

function err(message: string, status = 400, origin: string | null = null): Response {
  return json({ error: message }, status, origin);
}

async function body<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 16_000) throw new Error("Request body is too large.");
  return await request.json() as T;
}

function randomHex(bytes: number): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return [...array].map(value => value.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromHex(value: string): Uint8Array {
  return new Uint8Array(value.match(/.{2}/g)?.map(pair => parseInt(pair, 16)) || []);
}

async function derive(password: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  // Cloudflare Workers currently supports at most 100,000 PBKDF2 iterations.
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: fromHex(saltHex),
    iterations: 100_000,
    hash: "SHA-256"
  }, key, 256);
  return base64(bits);
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return base64(digest);
}

function readSessionCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === COOKIE_NAME) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${30 * 24 * 60 * 60}; Secure; HttpOnly; SameSite=None; Partitioned`;
}

function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=None; Partitioned`;
}

async function authenticate(request: Request, env: Env): Promise<AuthenticatedSession | null> {
  const token = readSessionCookie(request);
  if (!token) return null;

  const tokenHash = await hashToken(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT users.id, users.username, sessions.session_id,
            sessions.expires_at, sessions.idle_expires_at, sessions.last_seen_at
       FROM sessions
       JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
        AND sessions.expires_at > ?
        AND sessions.idle_expires_at > ?`
  ).bind(tokenHash, now, now).first<SessionRow>();

  if (!row) return null;

  if (now - row.last_seen_at >= SESSION_TOUCH_INTERVAL_MS) {
    const nextIdleExpiry = Math.min(row.expires_at, now + IDLE_TIMEOUT_MS);
    await env.DB.prepare(
      "UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE token_hash = ? AND expires_at > ?"
    ).bind(now, nextIdleExpiry, tokenHash, now).run();
  }

  return {
    user: { id: row.id, username: row.username },
    sessionId: row.session_id,
    tokenHash
  };
}

async function createSession(user: User, request: Request, env: Env): Promise<string> {
  const token = randomHex(32);
  const tokenHash = await hashToken(token);
  const now = Date.now();
  const sessionId = crypto.randomUUID();
  const absoluteExpiry = now + ABSOLUTE_TIMEOUT_MS;
  const idleExpiry = now + IDLE_TIMEOUT_MS;
  const userAgent = (request.headers.get("User-Agent") || "Unknown browser").slice(0, 180);

  await env.DB.prepare(
    `INSERT INTO sessions
       (session_id, token_hash, user_id, expires_at, idle_expires_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(sessionId, tokenHash, user.id, absoluteExpiry, idleExpiry, now, userAgent).run();

  return token;
}

function requireTrustedMutation(request: Request): boolean {
  return allowedOrigin(request.headers.get("Origin")) !== null &&
    request.headers.get("X-AC-Request") === "1";
}

function validUsername(value: string): boolean {
  return /^[A-Za-z0-9_]{3,24}$/.test(value);
}
function validId(value: string): boolean {
  return /^[a-z0-9_:-]{1,48}$/.test(value);
}
function validColour(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}
const behaviours = new Set(["solid", "transparent", "glowing", "decorative"]);

const validItemId = (value: string): boolean =>
  validId(value) || /^player:[a-z0-9_]+:[a-z0-9_]+:[a-z0-9_]+$/.test(value);

// Placement semantics (ADR 0001): declarative rules only for now; executable
// player behaviour versions alongside these later. Malformed rules NEVER throw:
// they degrade to plain placement so one bad blob cannot crash the engine.
type SupportRule = "any" | "solid" | "none";
type BlockRules = { support: SupportRule; incompatibleWith: string[] };
const supports: string[] = ["any", "solid", "none"];

function parseRules(raw: unknown): BlockRules {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw && typeof raw === "object" ? raw : {};
    return {
      support: supports.includes(value.support) ? value.support : "solid",
      incompatibleWith: Array.isArray(value.incompatibleWith)
        ? value.incompatibleWith.filter((id: unknown) => typeof id === "string" && validItemId(id)).slice(0, 32)
        : []
    };
  } catch {
    return { support: "solid", incompatibleWith: [] };
  }
}

function rulesFromInput(raw: unknown): { rules: BlockRules; error: string | null } {
  if (raw === undefined || raw === null) return { rules: parseRules({}), error: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { rules: parseRules({}), error: "rules must be an object." };
  const value = raw as { support?: unknown; incompatibleWith?: unknown };
  if (value.support !== undefined && !supports.includes(String(value.support)))
    return { rules: parseRules({}), error: "rules.support must be one of: any, solid, none." };
  if (
    value.incompatibleWith !== undefined &&
    (!Array.isArray(value.incompatibleWith) || value.incompatibleWith.length > 32 ||
      value.incompatibleWith.some((id) => typeof id !== "string" || !validItemId(id)))
  )
    return { rules: parseRules({}), error: "rules.incompatibleWith must be an array of up to 32 valid item IDs." };
  return { rules: parseRules(value), error: null };
}

const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

type EditRow = { x: number; y: number; z: number; block_id: string };

// Resolve each cell's occupant: player edits override the deterministic base terrain.
async function resolveCells(env: Env, cells: Array<[number, number, number]>): Promise<Map<string, string>> {
  const where = cells.map(() => "(x=? AND y=? AND z=?)").join(" OR ");
  const params: number[] = [];
  for (const [x, y, z] of cells) params.push(x, y, z);
  const { results } = await env.DB
    .prepare(`SELECT x,y,z,block_id FROM world_edits WHERE ${where}`)
    .bind(...params)
    .all<EditRow>();
  const overrides = new Map(results.map(row => [cellKey(row.x, row.y, row.z), row.block_id]));
  const resolved = new Map<string, string>();
  for (const [x, y, z] of cells) {
    const override = overrides.get(cellKey(x, y, z));
    resolved.set(cellKey(x, y, z), override !== undefined ? override : baseBlock(x, y, z));
  }
  return resolved;
}

async function publishEdit(env: Env, x: number, y: number, z: number, blockId: string): Promise<void> {
  try {
    const stub = env.WORLD_LIVE.get(env.WORLD_LIVE.idFromName("world"));
    await stub.fetch(
      new Request("https://world-live.internal/publish", {
        method: "POST",
        body: JSON.stringify({ type: "edit", x, y, z, block_id: blockId })
      })
    );
  } catch (error) {
    console.error("World broadcast failed:", error);
  }
}

const WORLD_COORD_LIMIT = 1_000_000;
function worldCoords(data: { x: unknown; y: unknown; z: unknown }): { x: number; y: number; z: number } | null {
  const x = Number(data.x);
  const y = Number(data.y);
  const z = Number(data.z);
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) ||
      x < -WORLD_COORD_LIMIT || x > WORLD_COORD_LIMIT || z < -WORLD_COORD_LIMIT || z > WORLD_COORD_LIMIT ||
      y < 0 || y >= WORLD_Y)
    return null;
  return { x, y, z };
}

type BlockRow = {
  id: string; name: string; creator: string; hardness: number; light: number;
  colour: string; behaviour: string; rules_json: string; is_builtin: number;
};

async function listBlocks(env: Env): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    "SELECT id,name,creator_name AS creator,hardness,light,colour,behaviour,rules_json,is_builtin FROM blocks ORDER BY is_builtin DESC,name LIMIT 500"
  ).all<BlockRow>();
  return results.map(row => ({
    id: row.id, name: row.name, creator: row.creator, hardness: row.hardness, light: row.light,
    colour: row.colour, behaviour: row.behaviour, is_builtin: row.is_builtin, rules: parseRules(row.rules_json)
  }));
}

async function listRecipes(env: Env): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    "SELECT id,name,creator_name AS creator,ingredients_json,result_id,quantity FROM recipes ORDER BY created_at DESC LIMIT 500"
  ).all<any>();
  return results.map(row => ({ ...row, ingredients: JSON.parse(row.ingredients_json) }));
}

type StackRow = { quantity: number };
type RecipeRow = { id: string; name: string; ingredients_json: string; result_id: string; quantity: number };
type LogRow = { seq: number; x: number; y: number; z: number; block_id: string };

// The placement engine (ADR 0001): validation as data, refusals return the item
// to the player (nothing is debited on refusal), and every path returns a
// Response — a malformed definition can degrade, never crash the world.
async function handlePlace(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  const data = await body<{ x: unknown; y: unknown; z: unknown; item_id: unknown }>(request);
  const coords = worldCoords(data);
  if (!coords) return err(`Coordinates must be integers (x/z within ±1000000, y within 0..${WORLD_Y - 1}).`, 400, origin);
  const { x, y, z } = coords;
  const itemId = typeof data.item_id === "string" ? data.item_id.trim() : "";
  if (!validItemId(itemId)) return err("Invalid item ID.", 400, origin);

  const def = await env.DB.prepare("SELECT id, rules_json FROM blocks WHERE id = ?").bind(itemId).first<{ id: string; rules_json: string }>();
  if (!def) return err(`Unknown item "${itemId}". It must exist in the block registry before it can be placed.`, 400, origin);

  const rules = parseRules(def.rules_json);
  const neighbours: Array<[number, number, number]> = [
    [x - 1, y, z], [x + 1, y, z], [x, y, z - 1], [x, y, z + 1], [x, y - 1, z], [x, y + 1, z]
  ];
  const cells = await resolveCells(env, [[x, y, z], ...neighbours]);

  if (cells.get(cellKey(x, y, z)) !== "air")
    return json({ error: "That cell is already occupied.", code: "occupied" }, 409, origin);
  if (rules.support === "solid" && cells.get(cellKey(x, y - 1, z)) === "air")
    return json({ error: `${def.id} can only be placed on a solid surface.`, code: "no_support" }, 400, origin);
  if (rules.support === "none" && cells.get(cellKey(x, y - 1, z)) !== "air")
    return json({ error: `${def.id} needs empty space beneath it.`, code: "no_support" }, 400, origin);
  for (const [nx, ny, nz] of neighbours) {
    const neighbour = cells.get(cellKey(nx, ny, nz))!;
    if (rules.incompatibleWith.includes(neighbour))
      return json({
        error: `${def.id} refuses to touch ${neighbour}. Placement cancelled; the item stayed in your inventory.`,
        code: "incompatible"
      }, 409, origin);
  }

  const debit = await env.DB.prepare(
    "UPDATE inventories SET quantity=quantity-1, updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND item_id=? AND quantity>=1"
  ).bind(auth.user.id, itemId).run();
  if (!debit.meta.changes)
    return json({ error: `You have no ${itemId} in your inventory.`, code: "no_item" }, 400, origin);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO world_edits(x,y,z,block_id,placed_by) VALUES(?,?,?,?,?) ON CONFLICT(x,y,z) DO UPDATE SET block_id=excluded.block_id, placed_by=excluded.placed_by, created_at=CURRENT_TIMESTAMP"
    ).bind(x, y, z, itemId, auth.user.id),
    env.DB.prepare("INSERT INTO world_log(x,y,z,block_id) VALUES(?,?,?,?)").bind(x, y, z, itemId)
  ]);
  await publishEdit(env, x, y, z, itemId);
  return json({ ok: true, x, y, z, id: itemId }, 201, origin);
}

async function handleBreak(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  const data = await body<{ x: unknown; y: unknown; z: unknown }>(request);
  const coords = worldCoords(data);
  if (!coords) return err(`Coordinates must be integers (x/z within ±1000000, y within 0..${WORLD_Y - 1}).`, 400, origin);
  const { x, y, z } = coords;

  const cells = await resolveCells(env, [[x, y, z]]);
  const current = cells.get(cellKey(x, y, z))!;
  if (current === "air") return json({ error: "Nothing to break there.", code: "empty" }, 409, origin);
  if (current === "builtin:bedrock")
    return json({ error: "Bedrock is unbreakable.", code: "unbreakable" }, 400, origin);

  const stack = await env.DB.prepare("SELECT quantity FROM inventories WHERE user_id=? AND item_id=?").bind(auth.user.id, current).first<StackRow>();
  if (stack && stack.quantity >= 999)
    return json({ error: "That stack is full (999). Make room before breaking more.", code: "inventory_full" }, 400, origin);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO inventories(user_id,item_id,quantity) VALUES(?,?,1) ON CONFLICT(user_id,item_id) DO UPDATE SET quantity=quantity+1, updated_at=CURRENT_TIMESTAMP"
    ).bind(auth.user.id, current),
    env.DB.prepare(
      "INSERT INTO world_edits(x,y,z,block_id,placed_by) VALUES(?,?,?,?,?) ON CONFLICT(x,y,z) DO UPDATE SET block_id='air', placed_by=excluded.placed_by, created_at=CURRENT_TIMESTAMP"
    ).bind(x, y, z, "air", auth.user.id),
    env.DB.prepare("INSERT INTO world_log(x,y,z,block_id) VALUES(?,?,?,?)").bind(x, y, z, "air")
  ]);
  await publishEdit(env, x, y, z, "air");
  return json({ ok: true, x, y, z, dropped: current }, 200, origin);
}

// ---- player state: server-persisted position + look -------------------------

async function handleGetPlayerState(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  const row = await env.DB
    .prepare("SELECT x, y, z, yaw, pitch FROM player_state WHERE user_id=?")
    .bind(auth.user.id)
    .first<{ x: number; y: number; z: number; yaw: number; pitch: number }>();
  return json({ state: row ?? null }, 200, origin);
}

async function handlePutPlayerState(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  const data = await body<{ x: unknown; y: unknown; z: unknown; yaw: unknown; pitch: unknown }>(request);
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const x = n(data.x), y = n(data.y), z = n(data.z), yaw = n(data.yaw), pitch = n(data.pitch);
  if (x === null || y === null || z === null || yaw === null || pitch === null)
    return err("x, y, z, yaw and pitch must be finite numbers.", 400, origin);
  if (Math.abs(x) > 1e6 || Math.abs(z) > 1e6 || y < 0 || y > 256)
    return err("Position is outside the world.", 400, origin);
  await env.DB.prepare(
    "INSERT INTO player_state(user_id,x,y,z,yaw,pitch) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET x=excluded.x, y=excluded.y, z=excluded.z, yaw=excluded.yaw, pitch=excluded.pitch, updated_at=CURRENT_TIMESTAMP"
  ).bind(auth.user.id, x, y, z, yaw, pitch).run();
  return json({ ok: true }, 200, origin);
}

async function handleCraft(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  const data = await body<{ recipe_id: unknown }>(request);
  const recipeId = typeof data.recipe_id === "string" ? data.recipe_id : "";
  if (!/^[0-9a-f-]{36}$/i.test(recipeId)) return err("Invalid recipe id.", 400, origin);

  const recipe = await env.DB.prepare("SELECT id,name,ingredients_json,result_id,quantity FROM recipes WHERE id=?").bind(recipeId).first<RecipeRow>();
  if (!recipe) return err("Recipe not found.", 404, origin);

  const resultRegistered = await env.DB.prepare("SELECT id FROM blocks WHERE id=?").bind(recipe.result_id).first();
  if (!resultRegistered)
    return json({ error: `The result "${recipe.result_id}" is not in the block registry, so it cannot be crafted.`, code: "unknown_result" }, 409, origin);

  const required = new Map<string, number>();
  try {
    const parsed: unknown = JSON.parse(recipe.ingredients_json);
    if (Array.isArray(parsed))
      for (const id of parsed) if (typeof id === "string") required.set(id, (required.get(id) || 0) + 1);
  } catch {
    return json({ error: "This recipe's ingredients are corrupted and cannot be used.", code: "corrupt" }, 409, origin);
  }

  const invRows = await env.DB
    .prepare("SELECT item_id, quantity FROM inventories WHERE user_id=?")
    .bind(auth.user.id)
    .all<{ item_id: string; quantity: number }>();
  const have = new Map(invRows.results.map(row => [row.item_id, row.quantity]));
  for (const [id, need] of required) {
    if ((have.get(id) || 0) < need)
      return json({ error: `Missing ${id} ×${need - (have.get(id) || 0)}.`, code: "missing" }, 400, origin);
  }
  if ((have.get(recipe.result_id) || 0) + recipe.quantity > 999)
    return json({ error: "The result stack would exceed 999. Make room first.", code: "inventory_full" }, 400, origin);

  const statements = [...required].map(([id, need]) =>
    env.DB.prepare("UPDATE inventories SET quantity=quantity-?, updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND item_id=? AND quantity>=?")
      .bind(need, auth.user.id, id, need));
  statements.push(env.DB.prepare(
    "INSERT INTO inventories(user_id,item_id,quantity) VALUES(?,?,?) ON CONFLICT(user_id,item_id) DO UPDATE SET quantity=quantity+?, updated_at=CURRENT_TIMESTAMP"
  ).bind(auth.user.id, recipe.result_id, recipe.quantity, recipe.quantity));
  await env.DB.batch(statements);
  return json({ ok: true, id: recipe.result_id, quantity: recipe.quantity }, 200, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    if (request.method === "OPTIONS") {
      if (!allowedOrigin(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (["POST", "PUT", "DELETE"].includes(request.method) && !requireTrustedMutation(request)) {
        return err("Request origin could not be verified.", 403, origin);
      }

      if (path === "/api/health" && request.method === "GET") {
        return json({ ok: true, service: "all-contribute", time: new Date().toISOString() }, 200, origin);
      }

      if (path === "/api/register" && request.method === "POST") {
        const data = await body<{ username: string; password: string }>(request);
        const username = String(data.username || "").trim();
        const password = String(data.password || "");
        if (!validUsername(username)) return err("Username must be 3–24 characters: letters, numbers or underscores.", 400, origin);
        if (password.length < 8 || password.length > 128) return err("Password must be 8–128 characters.", 400, origin);

        const user = { id: crypto.randomUUID(), username };
        const salt = randomHex(16);
        const passwordHash = await derive(password, salt);
        try {
          await env.DB.prepare(
            "INSERT INTO users(id,username,password_hash,password_salt) VALUES(?,?,?,?)"
          ).bind(user.id, username, passwordHash, salt).run();
        } catch {
          return err("That username is already taken.", 409, origin);
        }

        const token = await createSession(user, request, env);
        return json({ username }, 201, origin, { "Set-Cookie": sessionCookie(token) });
      }

      if (path === "/api/login" && request.method === "POST") {
        const data = await body<{ username: string; password: string }>(request);
        const username = String(data.username || "").trim();
        const password = String(data.password || "");
        const row = await env.DB.prepare(
          "SELECT id,username,password_hash,password_salt FROM users WHERE username=? COLLATE NOCASE"
        ).bind(username).first<any>();
        if (!row || password.length > 128 || await derive(password, row.password_salt) !== row.password_hash) {
          return err("Incorrect username or password.", 401, origin);
        }

        const user = { id: row.id, username: row.username };
        const token = await createSession(user, request, env);
        return json({ username: user.username }, 200, origin, { "Set-Cookie": sessionCookie(token) });
      }

      if (path === "/api/logout" && request.method === "POST") {
        const token = readSessionCookie(request);
        if (token) {
          const tokenHash = await hashToken(token);
          await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
        }
        return json({ ok: true }, 200, origin, { "Set-Cookie": clearSessionCookie() });
      }

      if (path === "/api/me" && request.method === "GET") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Session expired or not logged in.", 401, origin);
        return json({ user: auth.user }, 200, origin);
      }

      if (path === "/api/sessions" && request.method === "GET") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Session expired or not logged in.", 401, origin);
        const now = Date.now();
        const { results } = await env.DB.prepare(
          `SELECT session_id, user_agent, created_at, last_seen_at,
                  idle_expires_at, expires_at
             FROM sessions
            WHERE user_id = ? AND expires_at > ? AND idle_expires_at > ?
            ORDER BY created_at DESC`
        ).bind(auth.user.id, now, now).all<any>();
        return json({
          sessions: results.map(row => ({
            session_id: row.session_id,
            user_agent: row.user_agent,
            created_at: row.created_at,
            last_seen_at: row.last_seen_at,
            idle_expires_at: row.idle_expires_at,
            expires_at: row.expires_at,
            is_current: row.session_id === auth.sessionId
          }))
        }, 200, origin);
      }

      const sessionMatch = path.match(/^\/api\/sessions\/([0-9a-f-]{36})$/i);
      if (sessionMatch && request.method === "DELETE") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Session expired or not logged in.", 401, origin);
        if (sessionMatch[1] === auth.sessionId) return err("Use 'Log out this device' to end the current session.", 400, origin);
        const result = await env.DB.prepare(
          "DELETE FROM sessions WHERE session_id = ? AND user_id = ?"
        ).bind(sessionMatch[1], auth.user.id).run();
        if (!result.meta.changes) return err("Session not found.", 404, origin);
        return json({ ok: true }, 200, origin);
      }

      if (path === "/api/blocks" && request.method === "GET") {
        return json({ blocks: await listBlocks(env) }, 200, origin);
      }

      if (path === "/api/blocks" && request.method === "POST") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const data = await body<any>(request);
        const name = String(data.name || "").trim();
        const id = String(data.id || "").trim();
        // Optional for old cached frontends; defaults to "default".
        const namespace = String(data.namespace || "default").trim();
        const hardness = Number(data.hardness);
        const light = Number(data.light);
        const colour = String(data.colour || "");
        const behaviour = String(data.behaviour || "solid");
        if (name.length < 1 || name.length > 40) return err("Block name must be 1–40 characters.", 400, origin);
        if (!/^[A-Za-z0-9_]{1,24}$/.test(namespace)) return err("Namespace must be 1–24 characters (letters, numbers, underscores).", 400, origin);
        if (!/^[A-Za-z0-9_]{1,24}$/.test(id)) return err("Use a simple ID (letters, numbers and underscores).", 400, origin);
        if (!Number.isFinite(hardness) || hardness < 0 || hardness > 1000) return err("Hardness must be 0–1000.", 400, origin);
        if (!Number.isInteger(light) || light < 0 || light > 15) return err("Light must be an integer from 0 to 15.", 400, origin);
        if (!validColour(colour) || !behaviours.has(behaviour)) return err("Invalid colour or behaviour.", 400, origin);
        const { rules, error: rulesError } = rulesFromInput(data.rules);
        if (rulesError) return err(`Invalid placement rules: ${rulesError}`, 400, origin);
        // Registry ID: player:USERNAME:NAMESPACE:BLOCKNAME — the display name
        // (name) is separate, exactly like builtins (builtin:grass / "Grass").
        const fullId = `player:${auth.user.username.toLowerCase()}:${namespace.toLowerCase()}:${id.toLowerCase()}`;
        try {
          await env.DB.prepare(
            "INSERT INTO blocks(id,name,creator_id,creator_name,hardness,light,colour,behaviour,rules_json,is_builtin) VALUES(?,?,?,?,?,?,?,?,?,0)"
          ).bind(fullId, name, auth.user.id, auth.user.username, hardness, light, colour, behaviour, JSON.stringify(rules)).run();
        } catch {
          return err("That block ID already exists.", 409, origin);
        }
        return json({ ok: true, id: fullId }, 201, origin);
      }

      const blockMatch = path.match(/^\/api\/blocks\/(.+)$/);
      if (blockMatch && request.method === "PUT") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const id = decodeURIComponent(blockMatch[1]);
        const data = await body<any>(request);
        const existing = await env.DB.prepare(
          "SELECT creator_id,is_builtin FROM blocks WHERE id=?"
        ).bind(id).first<any>();
        if (!existing) return err("Block not found.", 404, origin);
        if (existing.is_builtin) return err("Built-in blocks are immutable.", 403, origin);
        if (existing.creator_id !== auth.user.id) return err("Only the creator can edit this block.", 403, origin);
        const name = String(data.name || "").trim();
        const hardness = Number(data.hardness);
        const light = Number(data.light);
        const colour = String(data.colour || "");
        const behaviour = String(data.behaviour || "solid");
        if (name.length < 1 || name.length > 40 || !Number.isFinite(hardness) || hardness < 0 || hardness > 1000 ||
            !Number.isInteger(light) || light < 0 || light > 15 || !validColour(colour) || !behaviours.has(behaviour)) {
          return err("Invalid block fields.", 400, origin);
        }
        const { rules, error: rulesError } = rulesFromInput(data.rules);
        if (rulesError) return err(`Invalid placement rules: ${rulesError}`, 400, origin);
        await env.DB.prepare(
          "UPDATE blocks SET name=?,hardness=?,light=?,colour=?,behaviour=?,rules_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
        ).bind(name, hardness, light, colour, behaviour, JSON.stringify(rules), id).run();
        return json({ ok: true }, 200, origin);
      }

      if (blockMatch && request.method === "DELETE") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const id = decodeURIComponent(blockMatch[1]);
        const existing = await env.DB.prepare(
          "SELECT creator_id,is_builtin FROM blocks WHERE id=?"
        ).bind(id).first<any>();
        if (!existing) return err("Block not found.", 404, origin);
        if (existing.is_builtin) return err("Built-in blocks are immutable.", 403, origin);
        if (existing.creator_id !== auth.user.id) return err("Only the creator can delete this block.", 403, origin);
        // Deleting a block cascades: its placed copies are restored to terrain
        // and referencing recipes are dropped, so "delete my test block" always
        // works without manual world cleanup first.
        const placed = await env.DB.prepare(
          "SELECT x,y,z FROM world_edits WHERE block_id=?"
        ).bind(id).all<{ x: number; y: number; z: number }>();
        const recipes = await env.DB.prepare(
          "SELECT ingredients_json FROM recipes WHERE result_id=? OR ingredients_json LIKE ?"
        ).bind(id, `%"${id}"%`).all<{ ingredients_json: string }>();
        await env.DB.prepare("DELETE FROM world_edits WHERE block_id=?").bind(id).run();
        await env.DB.prepare("DELETE FROM recipes WHERE result_id=? OR ingredients_json LIKE ?")
          .bind(id, `%"${id}"%`).run();
        for (const cell of placed.results) {
          await publishEdit(env, cell.x, cell.y, cell.z, "air");
        }
        await env.DB.prepare("DELETE FROM blocks WHERE id=?").bind(id).run();
        // Stale inventory stacks for a block that no longer exists are dead weight.
        await env.DB.prepare("DELETE FROM inventories WHERE item_id=?").bind(id).run();
        return json({
          ok: true,
          cleared: { placed: placed.results.length, recipes: recipes.results.length },
        }, 200, origin);
      }

      if (path === "/api/recipes" && request.method === "GET") {
        return json({ recipes: await listRecipes(env) }, 200, origin);
      }

      if (path === "/api/recipes" && request.method === "POST") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const data = await body<any>(request);
        const name = String(data.name || "").trim();
        const ingredients: string[] = Array.isArray(data.ingredients) ? data.ingredients.map((value: unknown) => String(value)) : [];
        const resultId = String(data.result_id || "").trim();
        const quantity = Number(data.quantity);
        if (name.length < 1 || name.length > 60 || ingredients.length < 1 || ingredients.length > 9 ||
            ingredients.some(value => !validItemId(value)) || !validItemId(resultId) ||
            !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
          return err("Invalid recipe fields.", 400, origin);
        }
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO recipes(id,name,creator_id,creator_name,ingredients_json,result_id,quantity) VALUES(?,?,?,?,?,?,?)"
        ).bind(id, name, auth.user.id, auth.user.username, JSON.stringify(ingredients), resultId, quantity).run();
        return json({ ok: true, id }, 201, origin);
      }

      // ---- Shared world --------------------------------------------------------
      if (path === "/api/world/live" && request.headers.get("Upgrade") === "websocket") {
        const stub = env.WORLD_LIVE.get(env.WORLD_LIVE.idFromName("world"));
        return stub.fetch(request);
      }

      if (path === "/api/world" && request.method === "GET") {
        const coord = (name: string): number => {
          const value = Number(url.searchParams.get(name));
          return Number.isInteger(value) && value >= -WORLD_COORD_LIMIT && value <= WORLD_COORD_LIMIT ? value : 0;
        };
        const x0 = coord("x0"), y0 = coord("y0"), z0 = coord("z0");
        const x1 = coord("x1"), y1 = coord("y1"), z1 = coord("z1");
        if (x1 < x0 || y1 < y0 || z1 < z0) return err("World window is invalid.", 400, origin);
        const since = Number(url.searchParams.get("since")) || 0;
        // Player edits are sparse overlays of the procedural base — a volume
        // query returns only the changed cells, capped well above any sane
        // active-world edit count.
        const [edits, log, head] = await Promise.all([
          env.DB.prepare("SELECT x,y,z,block_id FROM world_edits WHERE x BETWEEN ? AND ? AND y BETWEEN ? AND ? AND z BETWEEN ? AND ? LIMIT 20000")
            .bind(x0, x1, y0, y1, z0, z1).all<EditRow>(),
          env.DB.prepare("SELECT seq,x,y,z,block_id FROM world_log WHERE seq > ? ORDER BY seq ASC LIMIT 400")
            .bind(since).all<LogRow>(),
          env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM world_log").first<{ head: number }>()
        ]);
        return json({ edits: edits.results, log: log.results, head: head?.head ?? 0 }, 200, origin);
      }

      if (path === "/api/world/place" && request.method === "POST") return handlePlace(request, env, origin);
      if (path === "/api/world/break" && request.method === "POST") return handleBreak(request, env, origin);
      if (path === "/api/player/state" && request.method === "GET") return handleGetPlayerState(request, env, origin);
      if (path === "/api/player/state" && request.method === "POST") return handlePutPlayerState(request, env, origin);

      // ---- Inventory ------------------------------------------------------------
      if (path === "/api/inventory" && request.method === "GET") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const { results } = await env.DB
          .prepare("SELECT item_id, quantity FROM inventories WHERE user_id=? AND quantity>0 ORDER BY item_id")
          .bind(auth.user.id).all<{ item_id: string; quantity: number }>();
        return json({ inventory: results }, 200, origin);
      }

      if ((path === "/api/inventory/add" || path === "/api/inventory/remove") && request.method === "POST") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const data = await body<{ item_id: unknown; quantity: unknown }>(request);
        const itemId = typeof data.item_id === "string" ? data.item_id.trim().toLowerCase() : "";
        const quantity = Number(data.quantity);
        if (!validItemId(itemId)) return err("Use 1–48 letters, numbers, underscores, colons or hyphens for the item ID.", 400, origin);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return err("Quantity must be between 1 and 999.", 400, origin);
        if (path === "/api/inventory/add") {
          await env.DB.prepare(
            "INSERT INTO inventories(user_id,item_id,quantity) VALUES(?,?,?) ON CONFLICT(user_id,item_id) DO UPDATE SET quantity=min(999, quantity+?), updated_at=CURRENT_TIMESTAMP"
          ).bind(auth.user.id, itemId, quantity, quantity).run();
        } else {
          const removed = await env.DB.prepare(
            "UPDATE inventories SET quantity=quantity-?, updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND item_id=? AND quantity>=?"
          ).bind(quantity, auth.user.id, itemId, quantity).run();
          if (!removed.meta.changes) return err(`You do not have ${quantity} × ${itemId}.`, 400, origin);
          await env.DB.prepare("DELETE FROM inventories WHERE user_id=? AND item_id=? AND quantity<=0").bind(auth.user.id, itemId).run();
        }
        return json({ ok: true }, 200, origin);
      }

      if (path === "/api/inventory/clear" && request.method === "POST") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        await env.DB.prepare("DELETE FROM inventories WHERE user_id=?").bind(auth.user.id).run();
        return json({ ok: true }, 200, origin);
      }

      if (path === "/api/recipes/craft" && request.method === "POST") return handleCraft(request, env, origin);

      return err("Not found.", 404, origin);
    } catch (error) {
      console.error(error);
      return err(error instanceof Error ? error.message : "Internal server error.", 500, origin);
    }
  }
};
