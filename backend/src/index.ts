import { DurableObject } from "cloudflare:workers";

export interface Env {
  DB: D1Database;
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

// Keep this export because the original Cloudflare template created this class.
// It is a placeholder until world-region simulation is implemented.
export class MyDurableObject extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    return new Response("All Contribute Durable Object is ready!");
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

async function listBlocks(env: Env): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    "SELECT id,name,creator_name AS creator,hardness,light,colour,behaviour,is_builtin FROM blocks ORDER BY is_builtin DESC,name LIMIT 500"
  ).all();
  return results;
}

async function listRecipes(env: Env): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    "SELECT id,name,creator_name AS creator,ingredients_json,result_id,quantity FROM recipes ORDER BY created_at DESC LIMIT 500"
  ).all<any>();
  return results.map(row => ({ ...row, ingredients: JSON.parse(row.ingredients_json) }));
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
        const hardness = Number(data.hardness);
        const light = Number(data.light);
        const colour = String(data.colour || "");
        const behaviour = String(data.behaviour || "solid");
        if (name.length < 1 || name.length > 40) return err("Block name must be 1–40 characters.", 400, origin);
        if (!validId(id) || id.includes(":")) return err("Use a simple ID (letters, numbers and underscores).", 400, origin);
        if (!Number.isFinite(hardness) || hardness < 0 || hardness > 1000) return err("Hardness must be 0–1000.", 400, origin);
        if (!Number.isInteger(light) || light < 0 || light > 15) return err("Light must be an integer from 0 to 15.", 400, origin);
        if (!validColour(colour) || !behaviours.has(behaviour)) return err("Invalid colour or behaviour.", 400, origin);
        const fullId = `player:${auth.user.username.toLowerCase()}:${id}`;
        try {
          await env.DB.prepare(
            "INSERT INTO blocks(id,name,creator_id,creator_name,hardness,light,colour,behaviour,is_builtin) VALUES(?,?,?,?,?,?,?,?,0)"
          ).bind(fullId, name, auth.user.id, auth.user.username, hardness, light, colour, behaviour).run();
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
        await env.DB.prepare(
          "UPDATE blocks SET name=?,hardness=?,light=?,colour=?,behaviour=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
        ).bind(name, hardness, light, colour, behaviour, id).run();
        return json({ ok: true }, 200, origin);
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
        const validItemId = (value: string) => validId(value) || /^player:[a-z0-9_]+:[a-z0-9_]+$/.test(value);
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

      return err("Not found.", 404, origin);
    } catch (error) {
      console.error(error);
      return err(error instanceof Error ? error.message : "Internal server error.", 500, origin);
    }
  }
};
