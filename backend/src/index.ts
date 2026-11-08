import { DurableObject } from "cloudflare:workers";
import { baseBlock, heightAt, WORLD_Y } from "./terrain";
import { runBlockScript, type ScriptOutcome, type ScriptState } from "./lua";

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

// Character appearance colours, whitelisted and pattern-checked before they
// touch any presence frame — the DO never relays arbitrary client payload.
type Appearance = Partial<Record<"body_colour" | "head_colour" | "accent_colour" | "eye_colour", string>>;

function sanitizeAppearance(raw: unknown): Appearance | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const out: Appearance = {};
  for (const key of ["body_colour", "head_colour", "accent_colour", "eye_colour"] as const) {
    const colour = value[key];
    if (typeof colour === "string" && /^#[0-9a-f]{6}$/i.test(colour)) out[key] = colour;
  }
  return Object.keys(out).length ? out : undefined;
}

const MAX_HEALTH = 20;
const MAX_STACK = 999; // mirrors the inventories quantity CHECK
// How often a pose frame from a socket the object thinks is a corpse is allowed
// to re-read the stored health (see `reviveIfHealthy`).
const HEALTH_RECHECK_MS = 2000;

// Live fan-out for the shared world: keeps connected players' WebSockets and
// broadcasts each world edit. No hibernation (free tier): sockets live in
// memory; clients reconnect after eviction and the sequence-numbered polling
// fallback (world_log) fills any gaps, so delivery is best-effort but never
// leaves a client permanently stale.
//
// The object also owns the mob simulation: a 250 ms alarm tick spawns mobs
// around the connected players, walks them on the surface, resolves attacks
// both ways, and keeps each player's health in memory — mirrored to D1 at
// most once per second per player. REST handlers (respawn, eat) mutate D1
// themselves, then notify the object through the internal /respawn and
// /health endpoints so presence agrees and live sockets update immediately.

const MAX_MOBS = 12;
const MOB_TICK_MS = 250;
// Pose frames arrive four times a second from a visible tab. A hidden or
// backgrounded tab is not: Chrome's intensive throttling reduces its timers
// to roughly one wake-up a minute, so the window must sit past that — a real
// (if idle) player must never be evicted, or the sweep itself becomes the
// disconnect storm. Killed clients in production report close and are
// removed instantly by the close handler; this sweep is the backstop for
// connections whose close never arrives at all (wedged proxies, dev runtimes
// that never close sockets), and 100 s is generous enough for that job.
const PRESENCE_STALE_MS = 100_000;
// Mobs appear in a ring around the players, not on top of them: far enough to
// hear and see coming, close enough to be worth meeting. A hostile born at the
// far side of that ring still notices the player it was spawned for — the chase
// range sits just past the ring — so a world that spawns mobs at a distance
// never reads as empty.
const MOB_SPAWN_MIN = 40;
const MOB_SPAWN_MAX = 50;
const MOB_CHASE_RANGE = MOB_SPAWN_MAX + 8;
// A mob nobody can ever see is dead weight against the cap: once it is this far
// from every connected player it is removed, and the next ticks put a new one
// back at the ring. Without this, a mob that wandered off keeps its slot forever
// and the world quietly stops spawning.
const MOB_DESPAWN_RANGE = 96;
const MOB_ATTACK_RANGE = 1.8;
const MOB_ATTACK_COOLDOWN_MS = 1200;
const PLAYER_ATTACK_RANGE = 6;
// Bare hands: weaker and shorter than any swingable item, but never zero —
// a fresh account with an empty inventory is not helpless.
const FIST_DAMAGE = 1;
const FIST_RANGE = 3.5;
const ATTACK_COOLDOWN_MS = 600;
// Player edits are sparse; a few seconds of staleness on "what is the top of
// this column" is fine and keeps the tick's D1 reads tiny.
const COLUMN_TTL_MS = 5000;

type MobKind = "zombie" | "pig";

const MOB_SPECS: Record<MobKind, { hp: number; speed: number; damage: number; hostile: boolean }> = {
  zombie: { hp: 10, speed: 2.4, damage: 2, hostile: true },
  pig: { hp: 6, speed: 1.2, damage: 0, hostile: false }
};

type Mob = {
  id: string; kind: MobKind;
  x: number; y: number; z: number; yaw: number;
  hp: number; hostile: boolean;
  heading: number; nextThink: number; nextAttack: number;
};

// A connected player's pose plus the server-side health the simulation owns.
// health/dead are loaded lazily from D1 (by username) when first needed.
// `pitch` and `held` (a validated #rrggbb) exist so remote avatars can match
// where the looker is aiming and what they are holding.
type Presence = {
  name: string;
  x: number; y: number; z: number; yaw: number; pitch: number;
  vx: number; vy: number; vz: number;
  held?: string;
  heldItem?: string;
  appearance?: Appearance;
  health: number; dead: boolean; healthLoaded: boolean;
  // Wall-clock of the last pose frame. A socket whose frames stop (dead TCP
  // the runtime never reported closed, a wedged proxy) must not stand in
  // everyone's world forever: the object's tick sweeps entries older than
  // PRESENCE_STALE_MS, which is many times the 4 Hz pose rate.
  seen: number;
};

// Wire shape for roster/pose frames: pose + velocity (receivers dead-reckon
// between frames) + optional appearance. Internal fields never ship.
function wirePose(entry: Presence): Record<string, unknown> {
  return {
    name: entry.name, x: entry.x, y: entry.y, z: entry.z, yaw: entry.yaw, pitch: entry.pitch,
    vx: entry.vx, vy: entry.vy, vz: entry.vz,
    ...(entry.held ? { held: entry.held } : {}),
    ...(entry.heldItem ? { heldItem: entry.heldItem } : {}),
    ...(entry.appearance ? { appearance: entry.appearance } : {})
  };
}

// A held-item colour, exactly as the appearance colours are whitelisted: only
// a #rrggbb literal crosses the wire.
function sanitizeHeld(raw: unknown): string | undefined {
  return typeof raw === "string" && /^#[0-9a-f]{6}$/i.test(raw) ? raw : undefined;
}

// The held item's registry ID, so every client can draw that item's own icon
// in the hand from its registry copy. Same ID grammar the world tables use.
function sanitizeHeldItem(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length <= 64 && validItemId(raw) ? raw : undefined;
}

// The one admin identity in this deployment: the account literally named
// "admin". Inventory surgery (add/remove/clear) is theirs alone — players earn
// and spend items through the world instead. Exact match, no case folding.
const isAdminUser = (username: string): boolean => username === "admin";

// Internal header the router stamps on a world-socket upgrade: the account the
// session cookie belongs to. A Durable Object is only reachable through this
// Worker, and the router deletes any client-supplied value before setting it.
const WS_IDENTITY = "x-ac-user";

const round2 = (value: number): number => Math.round(value * 100) / 100;

export class WorldLive extends DurableObject<Env> {
  sockets: WebSocket[] = [];
  // Presence: socket -> current pose, so joining players see a roster and
  // everyone gets periodic pose fan-out (~5 Hz, client-throttled).
  presence: Map<WebSocket, Presence> = new Map();
  // Who each socket belongs to: the account behind the session cookie, or a
  // unique token for a socket that arrived without one. The router stamps it
  // on the upgrade request; a client frame never decides its own identity.
  // (It used to: everyone whose client had no username sent the fallback
  // "someone", so several players shared one avatar and any one of them
  // leaving removed it from everyone else's screen.)
  private identities: Map<WebSocket, string> = new Map();
  // When the account behind a "corpse" socket last re-read its stored health
  // (`reviveIfHealthy`); the corpse flag lives per socket, health per account.
  private healthRechecks: Map<string, number> = new Map();
  // The world's clock, mirrored from D1 so a socket that connects gets the
  // phase the admin left without another read (null = not dialled yet, so the
  // client reads the phase off its own wall clock).
  private clock: { phase: number | null; epoch: number; running: boolean } | null = null;
  mobs: Map<string, Mob> = new Map();
  // Lazily-filled caches that keep D1 reads tiny: column tops (short TTL)
  // and item stats (the registry is immutable for builtins).
  private columns: Map<string, { top: number; at: number }> = new Map();
  private itemCache: Map<string, { kind: string; damage: number } | null> = new Map();
  // Throttled health mirror: latest value per username + last write time.
  private pendingHealth: Map<string, number> = new Map();
  private lastHealthWrite: Map<string, number> = new Map();
  // Per-attacker swing gate (name -> earliest next swing).
  private attackCooldown: Map<string, number> = new Map();
  // One object instance == one server: the router idFromName()s the stub by
  // server id, so presence, mobs and the clock are per world by construction.
  // A Durable Object cannot recover the name its id was made from, so every
  // internal request carries the server id and the FIRST request binds it —
  // then it is stored, because alarm() runs against a re-instantiated object
  // after eviction and its writes must still land in this world's scope.
  private serverId: string | null = null;

  private async bindServer(id: unknown): Promise<void> {
    if (this.serverId) return;
    const stored = await this.ctx.storage.get<string>("server");
    this.serverId = stored || (typeof id === "string" && id ? id : GLOBAL_SERVER);
    if (!stored) await this.ctx.storage.put("server", this.serverId);
  }

  // Every world read/write this object makes is scoped. Before the first
  // request bound it there is nothing of its own to scope, and `global` keeps
  // the pre-servers behaviour byte-for-byte.
  private scope(): string {
    return this.serverId || GLOBAL_SERVER;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/presence") {
      await this.bindServer(url.searchParams.get("server"));
      return new Response(JSON.stringify({ count: this.presence.size }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (request.method === "POST" && url.pathname === "/publish") {
      // The wrapper keeps the id off the wire: only `frame` reaches sockets,
      // so `server` can never leak into a client's frame parser.
      const message = await request.json().catch(() => null) as { server?: unknown; frame?: unknown } | null;
      await this.bindServer(message?.server);
      if (message?.frame) this.broadcast(message.frame);
      return new Response("ok");
    }

    // Internal REST -> DO replay: the REST handler has just re-read
    // `world_edits` from D1, so fan that truth back out. The object keeps no
    // copy of the world — its only world belief is the column-top cache, and
    // that goes too, so the next mob/height read comes from D1 as well.
    if (request.method === "POST" && url.pathname === "/replay") {
      const message = await request.json().catch(() => null) as
        { server?: unknown; cells?: unknown; beams?: unknown; announce?: unknown } | null;
      await this.bindServer(message?.server);
      this.columns.clear();
      const cellOf = (raw: unknown): { x: number; y: number; z: number } | null => {
        if (!raw || typeof raw !== "object") return null;
        const cell = raw as Record<string, unknown>;
        const x = Number(cell.x), y = Number(cell.y), z = Number(cell.z);
        return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) ? { x, y, z } : null;
      };
      for (const raw of Array.isArray(message?.cells) ? message!.cells : []) {
        const cell = cellOf(raw);
        if (cell) this.broadcast({ type: "edit", ...cell, block_id: String((raw as Record<string, unknown>).block_id ?? "air") });
      }
      for (const raw of Array.isArray(message?.beams) ? message!.beams : []) {
        const cell = cellOf(raw);
        const colour = (raw as Record<string, unknown>).colour;
        if (cell && typeof colour === "string") this.broadcast({ type: "beam", ...cell, colour });
      }
      // One frame per resync, after the cells: clients throw away their own
      // overlay and re-read the snapshot, which also un-paints blocks the
      // snapshot never had.
      if (message?.announce) this.broadcast({ type: "resync" });
      return new Response("ok");
    }

    // Internal REST -> DO notifications: the REST handler has already
    // persisted the change; sync the in-memory presence and push a frame so
    // every socket of that player updates at once.
    if (request.method === "POST" && (url.pathname === "/respawn" || url.pathname === "/health")) {
      const payload = await request.json().catch(() => null) as
        { server?: unknown; name?: unknown; health?: unknown; state?: unknown } | null;
      await this.bindServer(payload?.server);
      const name = String(payload?.name || "");
      const health = Number(payload?.health);
      if (name && Number.isFinite(health)) {
        const clamped = Math.max(0, Math.min(MAX_HEALTH, health));
        const respawn = url.pathname === "/respawn";
        if (respawn) {
          this.reviveAccount(name, clamped, payload?.state);
        } else {
          for (const entry of this.presence.values()) {
            if (entry.name !== name) continue;
            entry.health = clamped;
            entry.healthLoaded = true;
            entry.dead = clamped <= 0;
          }
          this.pendingHealth.delete(name);
          this.sendToName(name, { type: "health", health: clamped });
        }
      }
      return new Response("ok");
    }

    // A block script moved the player: their sockets must hear it, or their own
    // next pose frame would drag them back to where they were. The presence
    // entry moves too, so everyone else sees the jump.
    if (request.method === "POST" && url.pathname === "/move") {
      const payload = await request.json().catch(() => null) as
        { server?: unknown; name?: unknown; x?: unknown; y?: unknown; z?: unknown } | null;
      await this.bindServer(payload?.server);
      const name = String(payload?.name || "");
      const x = Number(payload?.x), y = Number(payload?.y), z = Number(payload?.z);
      if (name && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        for (const entry of this.presence.values()) {
          if (entry.name !== name) continue;
          entry.x = x; entry.y = y; entry.z = z;
          entry.vx = 0; entry.vy = 0; entry.vz = 0;
        }
        this.sendToName(name, { type: "move", name, x, y, z });
        this.broadcast({ type: "roster", players: [...this.presence.values()].map(wirePose) });
      }
      return new Response("ok");
    }

    // The admin dialled the time of day: the Worker has already written the row,
    // so the object mirrors it and tells everyone looking at the sky at once.
    if (request.method === "POST" && url.pathname === "/clock") {
      const payload = await request.json().catch(() => null) as
        { server?: unknown; phase?: unknown; epoch?: unknown; running?: unknown } | null;
      await this.bindServer(payload?.server);
      const dialed = payload?.phase === null || payload?.phase === undefined ? null : Number(payload.phase);
      this.clock = {
        phase: dialed === null || !Number.isFinite(dialed) ? null : dialed,
        epoch: Number(payload?.epoch) || 0,
        running: payload?.running !== false
      };
      this.broadcast({ type: "time", ...this.clock });
      return new Response("ok");
    }

    if (request.headers.get("Upgrade") === "websocket") {
      // The upgrade carries no body, so the router passes the server id in the
      // forwarded query string; the stub is already this world's instance.
      await this.bindServer(url.searchParams.get("server"));
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.identities.set(server, (request.headers.get(WS_IDENTITY) || "").slice(0, 32)
        || `guest:${crypto.randomUUID().slice(0, 8)}`);
      this.sockets.push(server);
      // The first socket arms the simulation tick; alarm() re-arms it for
      // as long as anyone is connected.
      if (this.sockets.length === 1) void this.ctx.storage.setAlarm(Date.now() + MOB_TICK_MS);
      server.addEventListener("message", (event) => { void this.onMessage(server, event.data); });
      server.addEventListener("close", () => {
        this.sockets = this.sockets.filter((socket) => socket !== server);
        const name = this.nameOf(server);
        this.identities.delete(server);
        if (this.presence.delete(server) && name) {
          this.sendOthers(server, { type: "leave", name });
          void this.flushHealth(Date.now(), name);
        }
      });
      server.send(JSON.stringify({
        type: "roster",
        players: [...this.presence.values()].map(wirePose),
      }));
      // The sky is the world's, not each browser's: hand the new socket the
      // admin's dial (or the "not dialled" shape), so a reloaded page wakes up
      // in the same night everyone else is standing in. Off the handshake path:
      // the first read of the row is a D1 round trip.
      void this.clockFrame().then(frame => { try { server.send(JSON.stringify(frame)); } catch { /* socket gone */ } });
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Expected a WebSocket upgrade.", { status: 426 });
  }

  // 250 ms world tick: move mobs, resolve their attacks, mirror health,
  // spawn replacements, then re-arm while anyone is connected.
  async alarm(): Promise<void> {
    // A post-eviction tick has no request to bind with: re-read the stored id
    // so this world's mobs keep writing to their own scope.
    await this.bindServer(null);
    const now = Date.now();
    await this.ensureHealth();
    this.sweepStale(now);
    await this.stepMobs(now);
    this.broadcast({
      type: "mobs",
      mobs: [...this.mobs.values()].map(mob => ({
        id: mob.id, kind: mob.kind,
        x: round2(mob.x), y: round2(mob.y), z: round2(mob.z),
        yaw: round2(mob.yaw), hostile: mob.hostile, hp: mob.hp
      }))
    });
    await this.flushHealth(now);
    await this.spawnOne(now);
    if (this.sockets.length) await this.ctx.storage.setAlarm(Date.now() + MOB_TICK_MS);
  }

  // ---- simulation ----------------------------------------------------------

  // Sweep ghosts: a TCP that died without the runtime ever reporting close
  // (killed browser, wedged proxy, dev runtimes that never close sockets)
  // would otherwise stand in everyone's world forever — pose frames are the
  // heartbeat. A visible player sends one four times a second and even a
  // hidden, timer-throttled tab sends one about every minute, so the
  // PRESENCE_STALE_MS window only ever catches connections nobody is driving
  // anymore. The entry vanishes from rosters immediately; closing the object
  // side lets the usual close handler tidy anything the runtime still sees.
  private sweepStale(now: number): void {
    for (const [socket, entry] of [...this.presence]) {
      if (now - entry.seen < PRESENCE_STALE_MS) continue;
      this.presence.delete(socket);
      // A connection nobody drives may never report close either, so the
      // close handler that trims `sockets` may never run: trim here too, or
      // the alarm loop keeps ticking for a world with no one in it.
      this.sockets = this.sockets.filter((s) => s !== socket);
      const name = entry.name;
      this.sendOthers(socket, { type: "leave", name });
      void this.flushHealth(now, name);
      try { socket.close(1000, "stale"); } catch { /* the socket is already gone */ }
    }
  }

  private async stepMobs(now: number): Promise<void> {
    const players = [...this.presence.values()].filter(entry => !entry.dead);
    const dt = MOB_TICK_MS / 1000;
    // Forget anyone far out of everyone's sight, so the cap serves the players
    // who are actually standing somewhere. A dead player still counts: a mob
    // beside their body is part of that player's world.
    const watched = [...this.presence.values()];
    if (watched.length) {
      for (const mob of this.mobs.values()) {
        let nearest = Infinity;
        for (const entry of watched) nearest = Math.min(nearest, Math.hypot(entry.x - mob.x, entry.z - mob.z));
        if (nearest > MOB_DESPAWN_RANGE) this.mobs.delete(mob.id);
      }
    }
    for (const mob of this.mobs.values()) {
      const spec = MOB_SPECS[mob.kind];
      let target: Presence | null = null;
      if (mob.hostile) {
        let best = MOB_CHASE_RANGE;
        for (const player of players) {
          // Sphere, not circle: a player five blocks above is NOT next to the
          // mob just because their x/z columns overlap.
          const distance = Math.hypot(player.x - mob.x, player.y - mob.y, player.z - mob.z);
          if (distance < best) { best = distance; target = player; }
        }
      }
      if (target) {
        const dx = target.x - mob.x;
        const dy = target.y - mob.y;
        const dz = target.z - mob.z;
        // Steering stays horizontal — mobs walk the terrain surface — but the
        // range tests below are 3D, so reach and chase are spheres.
        const flat = Math.hypot(dx, dz) || 1;
        const reach = Math.hypot(dx, dy, dz);
        mob.heading = Math.atan2(dx, dz);
        if (flat > MOB_ATTACK_RANGE * 0.7 || Math.abs(dy) > MOB_ATTACK_RANGE) {
          mob.x += (dx / flat) * spec.speed * dt;
          mob.z += (dz / flat) * spec.speed * dt;
        }
        mob.yaw = mob.heading;
        if (reach <= MOB_ATTACK_RANGE && now >= mob.nextAttack && !target.dead) {
          mob.nextAttack = now + MOB_ATTACK_COOLDOWN_MS;
          await this.hurtPlayer(target, spec.damage, mob.kind);
        }
      } else {
        // Wander (peaceful mobs, or hostiles with nobody near): a fresh
        // random heading every 3-6 seconds, same surface walk.
        if (now >= mob.nextThink) {
          mob.heading = Math.random() * Math.PI * 2;
          mob.nextThink = now + 3000 + Math.random() * 3000;
        }
        mob.x += Math.cos(mob.heading) * spec.speed * dt;
        mob.z += Math.sin(mob.heading) * spec.speed * dt;
        mob.yaw = mob.heading;
      }
      mob.y = (await this.columnTop(Math.floor(mob.x), Math.floor(mob.z))) + 1;
    }
  }

  // Damage a connected player, from a mob (`by` = mob kind) or from another
  // player (`by` = attacker username). Tell the victim, persist, and zero
  // health means death — dead players stop being chased/hit and their pose
  // frames stop moving them.
  private async hurtPlayer(entry: Presence, amount: number, by: string): Promise<void> {
    entry.health = Math.max(0, entry.health - amount);
    // Everyone flashes the body that was hit: a PvP swing has to land visibly
    // for the attacker and onlookers, not only on the victim's screen.
    this.broadcast({ type: "hit", what: "player", id: entry.name });
    // The hurt frame carries the post-damage health AND a separate health
    // frame follows: a lost frame must never leave the HUD at full hearts.
    this.sendToName(entry.name, { type: "hurt", amount, by, health: entry.health });
    this.sendToName(entry.name, { type: "health", health: entry.health });
    if (entry.health <= 0 && !entry.dead) {
      entry.dead = true;
      this.pendingHealth.set(entry.name, 0);
      await this.flushHealth(Date.now(), entry.name);
      // Others see the body go down; the victim gets the death screen.
      this.broadcast({ type: "down", name: entry.name });
      this.sendToName(entry.name, { type: "died", by });
    } else {
      this.pendingHealth.set(entry.name, entry.health);
    }
  }

  private async spawnOne(now: number): Promise<void> {
    if (this.mobs.size >= MAX_MOBS || !this.sockets.length) return;
    const live = [...this.presence.values()].filter(entry => !entry.dead);
    if (!live.length) return;
    const anchor = live[Math.floor(Math.random() * live.length)];
    const angle = Math.random() * Math.PI * 2;
    const distance = MOB_SPAWN_MIN + Math.random() * (MOB_SPAWN_MAX - MOB_SPAWN_MIN);
    const x = anchor.x + Math.cos(angle) * distance;
    const z = anchor.z + Math.sin(angle) * distance;
    const kind: MobKind = Math.random() < 0.6 ? "zombie" : "pig";
    const spec = MOB_SPECS[kind];
    const id = crypto.randomUUID();
    this.mobs.set(id, {
      id, kind, x, z,
      y: (await this.columnTop(Math.floor(x), Math.floor(z))) + 1,
      yaw: angle, hp: spec.hp, hostile: spec.hostile,
      heading: Math.random() * Math.PI * 2,
      nextThink: now + 3000 + Math.random() * 3000,
      nextAttack: 0
    });
  }

  // Top solid y of a column: terrain height, raised above any player-placed
  // block. Cached with a short TTL so the tick never floods D1.
  private async columnTop(x: number, z: number): Promise<number> {
    const key = `${x},${z}`;
    const cached = this.columns.get(key);
    if (cached && Date.now() - cached.at < COLUMN_TTL_MS) return cached.top;
    let top = heightAt(x, z);
    try {
      const { results } = await this.env.DB
        .prepare("SELECT y, block_id FROM world_edits WHERE server_id=? AND x=? AND z=?")
        .bind(this.scope(), x, z).all<{ y: number; block_id: string }>();
      for (const edit of results)
        if (edit.block_id !== "air" && edit.y > top) top = edit.y;
    } catch (error) {
      console.error("Column lookup failed:", error);
    }
    this.columns.set(key, { top, at: Date.now() });
    return top;
  }

  // The clock frame every socket is handed when it arrives: the admin's dial if
  // one exists, otherwise the "not dialled" shape that leaves each client
  // reading the phase off its own wall clock (the pre-admin behaviour, and the
  // reason an undialled world needs no traffic at all).
  private async clockFrame(): Promise<Record<string, unknown>> {
    if (this.clock === null) {
      try {
        const { results } = await this.env.DB
          .prepare("SELECT phase, epoch_ms, running FROM world_clock WHERE id=1 AND server_id=?")
          .bind(this.scope()).all<{ phase: number | null; epoch_ms: number; running: number }>();
        const row = results[0];
        this.clock = {
          phase: row?.phase === null || row?.phase === undefined ? null : Number(row.phase),
          epoch: Number(row?.epoch_ms) || 0,
          running: (row?.running ?? 1) !== 0
        };
      } catch (error) {
        console.error("Clock read failed:", error);
        return { type: "time", phase: null, epoch: 0, running: true };
      }
    }
    return { type: "time", ...this.clock };
  }

  // Stand an account back up in the object's view of every socket it owns:
  // its health, the corpse flag, and the frames that lift the body on its own
  // screen (`respawn`) and in everyone else's (`up`).
  private reviveAccount(name: string, health: number, state?: unknown): void {
    for (const entry of this.presence.values()) {
      if (entry.name !== name) continue;
      entry.health = health;
      entry.healthLoaded = true;
      entry.dead = false;
    }
    this.pendingHealth.delete(name);
    const frame: Record<string, unknown> = { type: "respawn", health };
    if (state && typeof state === "object") frame.state = state;
    this.sendToName(name, frame);
    this.broadcast({ type: "up", name });
  }

  // Death is remembered per socket while health belongs to the account, and the
  // two can come apart: a second socket for the same account (another tab, a
  // reconnect that overlaps the socket it replaces, a block script that healed
  // them) restores the stored health while this socket's entry is still a
  // corpse. The player then walks around their own screen while every peer sees
  // a body nailed to the ground — "other players never show up", with a healthy
  // socket. Stored health is the authority, so a pose frame from a socket the
  // object believes is dead re-reads it (throttled per account) and stands the
  // body back up when the two disagree. A genuinely dead account reads 0 and
  // stays exactly as frozen as it should be.
  private async reviveIfHealthy(name: string): Promise<void> {
    const now = Date.now();
    if ((this.healthRechecks.get(name) ?? 0) > now) return;
    this.healthRechecks.set(name, now + HEALTH_RECHECK_MS);
    let health = 0;
    try {
      const row = await this.env.DB.prepare(
        `SELECT ps.health AS health FROM player_state ps
           JOIN users u ON u.id = ps.user_id
          WHERE u.username = ? AND ps.server_id = ?`
      ).bind(name, this.scope()).first<{ health: number }>();
      if (row) health = Math.max(0, Math.min(MAX_HEALTH, Number(row.health) || 0));
    } catch (error) {
      console.error("Health re-read failed:", error);
      return;
    }
    if (health <= 0) return;
    this.reviveAccount(name, health);
  }

  // First tick touch for freshly connected sockets: pull the stored health so
  // a player who left at 4 HP comes back damaged. Health 0 is NOT carried
  // across a connection — a new socket is a new life. Restoring death made the
  // player permanently invisible to peers: while entry.dead is set the DO drops
  // every pose frame they send, so the roster still listed them but no client
  // ever learned where they were.
  private async ensureHealth(): Promise<void> {
    const names = new Set<string>();
    for (const entry of this.presence.values())
      if (!entry.healthLoaded) names.add(entry.name);
    for (const name of names) {
      let health = MAX_HEALTH;
      try {
        const row = await this.env.DB.prepare(
          `SELECT ps.health AS health FROM player_state ps
             JOIN users u ON u.id = ps.user_id
            WHERE u.username = ? AND ps.server_id = ?`
        ).bind(name, this.scope()).first<{ health: number }>();
        if (row) {
          health = Math.max(0, Math.min(MAX_HEALTH, Number(row.health) || 0));
          if (health <= 0) {
            health = MAX_HEALTH;
            // Persist the revival so a DO restart cannot resurrect the corpse.
            this.pendingHealth.set(name, health);
          }
        }
      } catch (error) {
        console.error("Health load failed:", error);
      }
      for (const entry of this.presence.values()) {
        if (entry.name === name && !entry.healthLoaded) {
          entry.health = health;
          entry.dead = false;
          entry.healthLoaded = true;
        }
      }
      // The client must not guess its starting life from the stored row: a
      // stored 0 is revived here, so the object announces the real number.
      this.sendToName(name, { type: "health", health });
    }
  }

  // Mirror changed health into D1, at most one write per second per player
  // (forceName bypasses the throttle for deaths).
  private async flushHealth(now: number, forceName?: string): Promise<void> {
    for (const [name, health] of [...this.pendingHealth]) {
      if (name !== forceName && now - (this.lastHealthWrite.get(name) ?? 0) < 1000) continue;
      this.pendingHealth.delete(name);
      this.lastHealthWrite.set(name, now);
      try {
        await this.env.DB.prepare(
          `INSERT INTO player_state(user_id,server_id,x,y,z,yaw,pitch,health)
           SELECT id, ?, ?, ?, ?, 0, 0, ? FROM users WHERE username = ?
           ON CONFLICT(user_id, server_id) DO UPDATE SET health=excluded.health, updated_at=CURRENT_TIMESTAMP`
        ).bind(this.scope(), 0.5, heightAt(0, 0) + 2.7, 0.5, health, name).run();
      } catch (error) {
        console.error("Health persist failed:", error);
      }
    }
  }

  // ---- client messages ------------------------------------------------------

  private nameOf(socket: WebSocket): string {
    return this.identities.get(socket) || this.presence.get(socket)?.name || "";
  }

  private async onMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return;
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    // Client frames: field-by-field sanitised below; never relayed raw.
    const msg = parsed as Record<string, unknown>;
    if (msg.type === "who") {
      socket.send(JSON.stringify({ type: "roster", players: [...this.presence.values()].map(wirePose) }));
    } else if (msg.type === "pose") {
      const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
      // Identity is the socket's, never the frame's: the name a client sends
      // is decorative and collides the moment two sockets have none.
      // No identity means the socket was already swept or closed out from
      // under the client: a frame still in flight must not resurrect it.
      const name = this.nameOf(socket);
      if (!name) return;
      const entry = this.presence.get(socket);
      // Death freezes you: a dead player's pose frames stop moving them —
      // unless the stored health says the object is wrong about that.
      if (entry?.dead) {
        await this.reviveIfHealthy(name);
        if (entry.dead) return;
      }
      const appearance = sanitizeAppearance(msg.appearance);
      const held = sanitizeHeld(msg.held);
      const heldItem = sanitizeHeldItem(msg.heldItem);
      const pose: Presence = {
        name, x: num(msg.x), y: num(msg.y), z: num(msg.z), yaw: num(msg.yaw),
        pitch: Math.max(-1.6, Math.min(1.6, num(msg.pitch))),
        vx: num(msg.vx), vy: num(msg.vy), vz: num(msg.vz),
        ...(held ? { held } : {}),
        ...(heldItem ? { heldItem } : {}),
        ...(appearance ? { appearance } : {}),
        health: entry?.health ?? MAX_HEALTH,
        dead: entry?.dead ?? false,
        healthLoaded: entry?.healthLoaded ?? false,
        seen: Date.now()
      };
      this.presence.set(socket, pose);
      this.sendOthers(socket, { type: "pose", ...wirePose(pose) });
    } else if (msg.type === "attack") {
      await this.handleAttack(socket, msg);
    }
  }

  // One attack frame from a client: `mob_id` hits a mob, `target` hits another
  // player. Bare hands work too — with no swingable item selected the swing is
  // a fist (FIST_DAMAGE, half reach), which is what you have before you craft.
  private async handleAttack(socket: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const entry = this.presence.get(socket);
    if (!entry || entry.dead) return;
    const now = Date.now();
    // Swing rate is server-side: a client cannot attack faster than this.
    if (now < (this.attackCooldown.get(entry.name) ?? 0)) return;
    const itemId = typeof msg.item_id === "string" ? msg.item_id : "";
    const item = await this.itemStats(itemId);
    const armed = !!item && (item.kind === "weapon" || item.kind === "tool");
    const damage = armed ? Math.max(1, item.damage) : FIST_DAMAGE;
    const reach = armed ? PLAYER_ATTACK_RANGE : FIST_RANGE;
    this.attackCooldown.set(entry.name, now + ATTACK_COOLDOWN_MS);

    const targetName = typeof msg.target === "string" ? msg.target : "";
    if (targetName && targetName !== entry.name) {
      let victim: Presence | null = null;
      for (const other of this.presence.values())
        if (other.name === targetName && !other.dead) { victim = other; break; }
      if (!victim) return;
      if (Math.hypot(victim.x - entry.x, victim.y - entry.y, victim.z - entry.z) > reach) return;
      await this.hurtPlayer(victim, damage, entry.name);
      return;
    }

    const mob = this.mobs.get(String(msg.mob_id ?? ""));
    if (!mob) return;
    if (Math.hypot(mob.x - entry.x, mob.y - entry.y, mob.z - entry.z) > reach) return;
    this.broadcast({ type: "hit", what: "mob", id: mob.id, damage });
    mob.hp -= damage;
    if (mob.hp <= 0) {
      this.mobs.delete(mob.id);
      // Kill reward: hostile drops a stick (crafting), pigs drop food.
      await this.creditInventory(entry.name, mob.hostile ? "builtin:stick" : "builtin:apple");
    }
  }

  private async itemStats(itemId: string): Promise<{ kind: string; damage: number } | null> {
    if (!validId(itemId)) return null;
    if (this.itemCache.has(itemId)) return this.itemCache.get(itemId)!;
    let stats: { kind: string; damage: number } | null = null;
    try {
      const row = await this.env.DB
        .prepare("SELECT kind, damage FROM items WHERE id=?")
        .bind(itemId).first<{ kind: string; damage: number }>();
      if (row) stats = { kind: row.kind, damage: row.damage };
    } catch (error) {
      console.error("Item lookup failed:", error);
      return null; // do not cache a failed lookup
    }
    this.itemCache.set(itemId, stats);
    return stats;
  }

  private async creditInventory(username: string, itemId: string): Promise<void> {
    try {
      await this.env.DB.prepare(
        `INSERT INTO inventories(user_id,item_id,quantity)
         SELECT id, ?, 1 FROM users WHERE username = ?
         ON CONFLICT(user_id,item_id) DO UPDATE SET quantity=min(999, quantity+1), updated_at=CURRENT_TIMESTAMP`
      ).bind(itemId, username).run();
    } catch (error) {
      console.error("Kill credit failed:", error);
    }
  }

  // ---- fan-out ---------------------------------------------------------------

  private sendToName(name: string, message: unknown): void {
    const data = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (this.presence.get(socket)?.name !== name) continue;
      try {
        socket.send(data);
      } catch {
        // Pruned by the close listener.
      }
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
    // The browser stamps X-AC-Device on EVERY request (it is the private-world
    // key), so the preflight has to carry it or no call survives.
    "Access-Control-Allow-Headers": "Content-Type,X-AC-Request,X-AC-Device",
    // Kept short on purpose: a browser that cached the old answer would reject a
    // new request header for the whole lifetime of that cache.
    "Access-Control-Max-Age": "60",
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
  // A POST with no body at all is a legitimate API call (respawn takes no
  // fields): parse the text, and read an empty one as no fields. Handlers
  // validate the fields they need either way. Throwing from here would
  // escape the router's catch (routes `return` handlers un-awaited) and the
  // client would see the runtime's bare error page instead of a JSON error.
  const text = await request.text();
  if (!text) return {} as T;
  if (text.length > 16_000) throw new Error("Request body is too large.");
  return JSON.parse(text) as T;
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
const behaviours = new Set(["solid", "transparent", "glowing", "decorative", "useful"]);
const itemKinds = new Set(["block", "tool", "weapon", "food", "material"]);

const validItemId = (value: string): boolean =>
  validId(value) || /^player:[a-z0-9_]+:[a-z0-9_]+:[a-z0-9_]+$/.test(value);

// A server is a scoped world: every world-table row carries the id of the
// server it belongs to. `global` — the shared world — is implicit: never a row
// in `servers`, and the column DEFAULT, so an absent/empty server field keeps
// the pre-servers behaviour byte-for-byte.
const GLOBAL_SERVER = "global";
// A free account's own-world budget; the site admin is exempt from nothing
// here because creation is only ever for the caller themself.
const MAX_SERVERS_PER_ACCOUNT = 3;

// The ONE place that derives which server a request acts on: a `server` body
// field on POSTs, `?server=` on GETs, absent or empty ⇒ `global`.
function serverOf(request: Request, bodyValue?: unknown): string {
  const raw = typeof bodyValue === "string" ? bodyValue : new URL(request.url).searchParams.get("server");
  const value = String(raw ?? "").trim();
  return value || GLOBAL_SERVER;
}

// Client IP: Workers stamps `cf` in production; dev (and proxied deployments)
// leave the first X-Forwarded-For hop as the only hint.
function clientIpOf(request: Request): string {
  const cf = request.cf;
  const stamped = cf && typeof cf === "object" && "clientIp" in cf && typeof cf.clientIp === "string" ? cf.clientIp : "";
  return stamped || (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim();
}

// Device secret -> stored hash. The secret never enters the database; a leaked
// `servers` row hands out nothing usable.
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// A browser cannot accept inbound connections, so `lan` visibility is defined
// by the address, not the network stack: both ends must be RFC1918 and sit in
// the same /24. Anything else fails closed and degrades to the private rule.
function rfc1918Octets(value: string | null): number[] | null {
  if (!value) return null;
  const parts = value.trim().split(".");
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some(octet => octet > 255)) return null;
  const [a, b] = octets;
  const lan = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  return lan ? octets : null;
}
function sameLan24(ip: string, hostIp: string | null): boolean {
  const a = rfc1918Octets(ip), b = rfc1918Octets(hostIp);
  return !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

type ServerRow = {
  id: string; name: string; owner: string; visibility: string;
  device_hash: string | null; host_ip: string | null;
};

// The join gate, shared by the world/player/time endpoints and the WS
// upgrade. Returns null when the caller may enter, else the Response to send.
// Invariants: `global` is always open; `public` is open; `lan` opens for the
// creator's /24 and for everyone the private rule opens; `private` opens only
// for the creating device (by hash), the logged-in owner, or the site admin.
// The error token names the failing rule — clients say WHY a world is closed.
async function gateServer(
  request: Request,
  env: Env,
  server: string,
  auth: AuthenticatedSession | null,
  origin: string | null
): Promise<Response | null> {
  if (server === GLOBAL_SERVER) return null;
  const row = await env.DB
    .prepare("SELECT id,name,owner,visibility,device_hash,host_ip FROM servers WHERE id=?")
    .bind(server).first<ServerRow>();
  if (!row) return err("server", 403, origin);
  if (row.visibility === "public") return null;
  if (row.visibility === "lan" && sameLan24(clientIpOf(request), row.host_ip)) return null;
  const owner = !!auth && (auth.user.username === row.owner || isAdminUser(auth.user.username));
  const device = request.headers.get("X-AC-Device") || "";
  if (owner || (/^[0-9a-f]{32,}$/i.test(device) && row.device_hash && await sha256Hex(device) === row.device_hash))
    return null;
  return err(row.visibility === "lan" ? "lan" : "private", 403, origin);
}

// The server list reports LIVE presence, not a stale DB count: only the
// object holding a world's sockets knows who is connected to it.
async function livePlayers(env: Env, server: string): Promise<number> {
  try {
    const stub = env.WORLD_LIVE.get(env.WORLD_LIVE.idFromName(server));
    const res = await stub.fetch(new Request(`https://world-live.internal/presence?server=${encodeURIComponent(server)}`));
    const data = await res.json() as { count?: number };
    return Number(data?.count) || 0;
  } catch {
    return 0;
  }
}

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
      // Floating placement is the norm here: a block dropped into mid-air
      // stays. Blocks that genuinely need the ground say so in rules_json.
      support: supports.includes(value.support) ? value.support : "any",
      incompatibleWith: Array.isArray(value.incompatibleWith)
        ? value.incompatibleWith.filter((id: unknown) => typeof id === "string" && validItemId(id)).slice(0, 32)
        : []
    };
  } catch {
    return { support: "any", incompatibleWith: [] };
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

// Resolve each cell's occupant in ONE world: player edits override the
// deterministic base terrain.
async function resolveCells(env: Env, server: string, cells: Array<[number, number, number]>): Promise<Map<string, string>> {
  const where = cells.map(() => "(x=? AND y=? AND z=?)").join(" OR ");
  const params: (string | number)[] = [server];
  for (const [x, y, z] of cells) params.push(x, y, z);
  const { results } = await env.DB
    .prepare(`SELECT x,y,z,block_id FROM world_edits WHERE server_id=? AND (${where})`)
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

// Fan one frame out to the sockets of ONE world: the stub is addressed BY
// SERVER, so an edit in one world can only ever reach that world's players.
// The wrapper body carries the id for the object's own binding; only `frame`
// is broadcast, so `server` never leaks into a client's frame parser.
async function publishFrame(env: Env, server: string, frame: Record<string, unknown>): Promise<void> {
  try {
    const stub = env.WORLD_LIVE.get(env.WORLD_LIVE.idFromName(server));
    await stub.fetch(
      new Request("https://world-live.internal/publish", {
        method: "POST",
        body: JSON.stringify({ server, frame })
      })
    );
  } catch (error) {
    console.error("World broadcast failed:", error);
  }
}

async function publishEdit(env: Env, server: string, x: number, y: number, z: number, blockId: string): Promise<void> {
  await publishFrame(env, server, { type: "edit", x, y, z, block_id: blockId });
}

// `world_edits` is the whole truth about the world; the catch-up log, the
// scripted blocks' per-cell memory and the cached light columns are all derived
// from it. A derived row can outlive its cell — deleting a block from the
// registry removes its `world_edits` rows and leaves the others behind — which
// is exactly "the world says a block is here, D1 says it isn't". Anything whose
// cell is gone is stale by construction, so it gets pruned.
const ORPHAN_COUNT = (table: string) =>
  `SELECT COUNT(*) AS n FROM ${table} w WHERE w.server_id=? AND NOT EXISTS (SELECT 1 FROM world_edits e WHERE e.server_id=w.server_id AND e.x=w.x AND e.y=w.y AND e.z=w.z)`;
const ORPHAN_PRUNE = (table: string) =>
  `DELETE FROM ${table} WHERE server_id=? AND NOT EXISTS (SELECT 1 FROM world_edits e WHERE e.server_id=${table}.server_id AND e.x=${table}.x AND e.y=${table}.y AND e.z=${table}.z)`;

async function pruneOrphanWorldRows(env: Env, server: string): Promise<{ log: number; state: number; beams: number; inv: number }> {
  const [log, state, beams, inv] = await Promise.all([
    env.DB.prepare(ORPHAN_COUNT("world_log")).bind(server).first<{ n: number }>(),
    env.DB.prepare(ORPHAN_COUNT("block_state")).bind(server).first<{ n: number }>(),
    env.DB.prepare(ORPHAN_COUNT("block_beams")).bind(server).first<{ n: number }>(),
    env.DB.prepare(ORPHAN_COUNT("block_inventory")).bind(server).first<{ n: number }>()
  ]);
  await env.DB.batch([
    env.DB.prepare(ORPHAN_PRUNE("world_log")).bind(server),
    env.DB.prepare(ORPHAN_PRUNE("block_state")).bind(server),
    env.DB.prepare(ORPHAN_PRUNE("block_beams")).bind(server),
    env.DB.prepare(ORPHAN_PRUNE("block_inventory")).bind(server)
  ]);
  return { log: log?.n ?? 0, state: state?.n ?? 0, beams: beams?.n ?? 0, inv: inv?.n ?? 0 };
}

// Tell the live object about a health change made over REST (respawn, eat) so
// its in-memory presence agrees and live sockets update. If the object is not
// running this is a harmless no-op. The payload carries the server id both to
// address the right instance and to bind it after eviction.
async function notifyLive(env: Env, server: string, endpoint: "respawn" | "health" | "move" | "clock", payload: Record<string, unknown>): Promise<void> {
  try {
    const stub = env.WORLD_LIVE.get(env.WORLD_LIVE.idFromName(server));
    await stub.fetch(
      new Request(`https://world-live.internal/${endpoint}`, {
        method: "POST",
        body: JSON.stringify({ ...payload, server })
      })
    );
  } catch (error) {
    console.error("Live health notify failed:", error);
  }
}

const WORLD_COORD_LIMIT = 1_000_000;
// The world log is a delivery aid, not a history archive: it exists so a
// client that missed a live frame can catch up. Only the newest edits matter —
// older ones are already baked into the `world_edits` snapshot every client
// loads when it joins — so the table is pruned to this many rows.
const WORLD_LOG_KEEP = 100;
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
  texture: string | null; texture_top: string | null; texture_bottom: string | null;
  model: string | null; script: string | null;
};

// The voxel models the renderer actually ships (vlox hardcodes the list; an
// unknown id breaks world start). The Studio offers these, and the Worker
// refuses anything else, so a published block can never brick a client.
const BLOCK_MODELS = new Set([
  "dve_simple_cube", "dve_full_texture_cube", "dve_transparent_simple_cube",
  "dve_no_cull_simple_cube", "dve_simple_half_cube", "dve_simple_stair",
  "dve_simple_thin_panel", "dve_simple_crossed_panels", "dve_pillar_cube", "dve_carpet",
]);

// A published PNG, as the Studio's canvas exports it: a base64 data URL.
// `limit` keeps the registry payload the game downloads on join small — 60 KB
// is far more than a 16x16 or 32x32 PNG ever needs.
function sanitizeImage(raw: unknown, limit: number, label: string): { value: string | null; error: string | null } {
  if (raw === undefined || raw === null || raw === "") return { value: null, error: null };
  if (typeof raw !== "string" || raw.length > limit || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(raw))
    return { value: null, error: `${label} must be a PNG image under ${Math.round(limit / 1024)} KB.` };
  return { value: raw, error: null };
}

function sanitizeModel(raw: unknown): { value: string | null; error: string | null } {
  if (raw === undefined || raw === null || raw === "") return { value: null, error: null };
  const model = String(raw);
  if (!BLOCK_MODELS.has(model)) return { value: null, error: "Unknown block model." };
  return { value: model, error: null };
}

// A block's Lua. The length cap is about keeping the registry small; the
// sandbox's own instruction/wall-clock budgets are what contain a bad script.
function sanitizeScript(raw: unknown): { value: string | null; error: string | null } {
  if (raw === undefined || raw === null || String(raw).trim() === "") return { value: null, error: null };
  const source = String(raw);
  if (source.length > 6000) return { value: null, error: "Block script must be under 6000 characters." };
  return { value: source, error: null };
}

async function listBlocks(env: Env): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    "SELECT id,name,creator_name AS creator,hardness,light,colour,behaviour,rules_json,is_builtin,texture,texture_top,texture_bottom,model,script FROM blocks ORDER BY is_builtin DESC,name LIMIT 500"
  ).all<BlockRow>();
  return results.map(row => ({
    id: row.id, name: row.name, creator: row.creator, hardness: row.hardness, light: row.light,
    colour: row.colour, behaviour: row.behaviour, is_builtin: row.is_builtin, rules: parseRules(row.rules_json),
    texture: row.texture ?? null, texture_top: row.texture_top ?? null, texture_bottom: row.texture_bottom ?? null,
    model: row.model ?? null, script: row.script ?? null
  }));
}

async function listRecipes(env: Env): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    "SELECT id,name,creator_name AS creator,ingredients_json,result_id,quantity FROM recipes ORDER BY created_at DESC LIMIT 500"
  ).all<any>();
  return results.map(row => ({ ...row, ingredients: JSON.parse(row.ingredients_json) }));
}

type ItemRow = {
  id: string; name: string; kind: string; place_block_id: string | null;
  damage: number; speed: number; heal: number; durability: number;
  colour: string; creator: string; is_builtin: number; icon: string | null;
};

async function listItems(env: Env): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    `SELECT id,name,kind,place_block_id,damage,speed,heal,durability,colour,creator_name AS creator,is_builtin,icon
       FROM items ORDER BY is_builtin DESC,name LIMIT 500`
  ).all<ItemRow>();
  return results;
}

// Held-item stats, shared by POST and PUT: omitted fields take the schema
// defaults. Returns null for any out-of-range value.
function itemStatsFromInput(data: Record<string, unknown>): { damage: number; speed: number; heal: number; durability: number } | null {
  const damage = Number(data.damage ?? 0);
  const speed = Number(data.speed ?? 1);
  const heal = Number(data.heal ?? 0);
  const durability = Number(data.durability ?? 0);
  if (!Number.isFinite(damage) || damage < 0 || damage > 50) return null;
  if (!Number.isFinite(speed) || speed < 0.1 || speed > 10) return null;
  if (!Number.isFinite(heal) || heal < 0 || heal > 20) return null;
  if (!Number.isInteger(durability) || durability < 0 || durability > 1000) return null;
  return { damage, speed, heal, durability };
}

// The item's programme: only 'block' items name a block to place, and that
// block must actually exist in the block registry. Non-block items must carry
// no programme at all. Returns an error message, or null when valid.
async function programmeFromInput(
  env: Env,
  kind: string,
  raw: unknown
): Promise<{ placeBlockId: string | null; error: string | null }> {
  const place = raw === undefined || raw === null ? null : String(raw).trim();
  if (kind !== "block") {
    if (place) return { placeBlockId: null, error: "Only block items can programme a block." };
    return { placeBlockId: null, error: null };
  }
  if (!place || !validItemId(place)) return { placeBlockId: null, error: "Pick a block this item places." };
  const block = await env.DB.prepare("SELECT id FROM blocks WHERE id=?").bind(place).first<{ id: string }>();
  if (!block) return { placeBlockId: null, error: "Pick a block this item places." };
  return { placeBlockId: place, error: null };
}

// Shared recipe body validation: POST and PUT must agree on exactly the same
// rules, so the checks live here once. Returns null for any invalid input.
function recipeFieldsFromInput(data: unknown): { name: string; ingredients: string[]; result_id: string; quantity: number } | null {
  const value = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const name = String(value.name ?? "").trim();
  const ingredients: string[] = Array.isArray(value.ingredients) ? value.ingredients.map((entry: unknown) => String(entry)) : [];
  const resultId = String(value.result_id ?? "").trim();
  const quantity = Number(value.quantity);
  if (name.length < 1 || name.length > 60 || ingredients.length < 1 || ingredients.length > 9 ||
      ingredients.some(entry => !validItemId(entry)) || !validItemId(resultId) ||
      !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    return null;
  }
  return { name, ingredients, result_id: resultId, quantity };
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
  const data = await body<{ x: unknown; y: unknown; z: unknown; item_id: unknown; server?: unknown }>(request);
  const server = serverOf(request, data.server);
  // Gate before anything is read or written: a stranger never even learns
  // whether the cell is occupied in someone else's world.
  const denied = await gateServer(request, env, server, auth, origin);
  if (denied) return denied;
  const coords = worldCoords(data);
  if (!coords) return err(`Coordinates must be integers (x/z within ±1000000, y within 0..${WORLD_Y - 1}).`, 400, origin);
  const { x, y, z } = coords;
  const itemId = typeof data.item_id === "string" ? data.item_id.trim() : "";
  if (!validItemId(itemId)) return err("Invalid item ID.", 400, origin);

  const item = await env.DB.prepare("SELECT id,kind,place_block_id FROM items WHERE id=?")
    .bind(itemId).first<{ id: string; kind: string; place_block_id: string | null }>();
  if (!item) return err(`Unknown item "${itemId}". It must exist in the item registry before it can be placed.`, 400, origin);
  if (item.kind !== "block" || !item.place_block_id)
    return json({ error: "Only items that place a block can be placed.", code: "not_placeable" }, 400, origin);
  const blockId = item.place_block_id;

  const def = await env.DB.prepare("SELECT id, rules_json FROM blocks WHERE id = ?").bind(blockId).first<{ id: string; rules_json: string }>();
  if (!def)
    return json({ error: `The block programmed into ${itemId} no longer exists in the block registry.`, code: "unknown_block" }, 409, origin);

  const rules = parseRules(def.rules_json);
  const neighbours: Array<[number, number, number]> = [
    [x - 1, y, z], [x + 1, y, z], [x, y, z - 1], [x, y, z + 1], [x, y - 1, z], [x, y + 1, z]
  ];
  const cells = await resolveCells(env, server, [[x, y, z], ...neighbours]);

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
      "INSERT INTO world_edits(server_id,x,y,z,block_id,placed_by) VALUES(?,?,?,?,?,?) ON CONFLICT(server_id,x,y,z) DO UPDATE SET block_id=excluded.block_id, placed_by=excluded.placed_by, created_at=CURRENT_TIMESTAMP"
    ).bind(server, x, y, z, blockId, auth.user.id),
    env.DB.prepare("INSERT INTO world_log(server_id,x,y,z,block_id) VALUES(?,?,?,?,?)").bind(server, x, y, z, blockId),
    // The log is a catch-up queue, not an archive: keep only the newest edits
    // of THIS world — another server's busy log must not evict this one's.
    env.DB.prepare("DELETE FROM world_log WHERE server_id=? AND seq <= (SELECT MAX(seq) - ? FROM world_log WHERE server_id=?)").bind(server, WORLD_LOG_KEEP, server)
  ]);
  await publishEdit(env, server, x, y, z, blockId);
  return json({ ok: true, x, y, z, id: blockId }, 201, origin);
}

async function handleBreak(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  const data = await body<{ x: unknown; y: unknown; z: unknown; server?: unknown }>(request);
  const server = serverOf(request, data.server);
  const denied = await gateServer(request, env, server, auth, origin);
  if (denied) return denied;
  const coords = worldCoords(data);
  if (!coords) return err(`Coordinates must be integers (x/z within ±1000000, y within 0..${WORLD_Y - 1}).`, 400, origin);
  const { x, y, z } = coords;

  const cells = await resolveCells(env, server, [[x, y, z]]);
  const current = cells.get(cellKey(x, y, z))!;
  if (current === "air") return json({ error: "Nothing to break there.", code: "empty" }, 409, origin);
  if (current === "builtin:bedrock")
    return json({ error: "Bedrock is unbreakable.", code: "unbreakable" }, 400, origin);

  // The credited drop is the item that programmes this block (builtin first);
  // blocks with no programming item fall back to their own id, preserving the
  // old behaviour for any leftover stacks.
  const dropper = await env.DB.prepare(
    "SELECT id FROM items WHERE place_block_id=? ORDER BY is_builtin DESC, id ASC LIMIT 1"
  ).bind(current).first<{ id: string }>();
  const dropId = dropper?.id ?? current;

  const stack = await env.DB.prepare("SELECT quantity FROM inventories WHERE user_id=? AND item_id=?").bind(auth.user.id, dropId).first<StackRow>();
  if (stack && stack.quantity >= MAX_STACK)
    return json({ error: "That stack is full (999). Make room before breaking more.", code: "inventory_full" }, 400, origin);

  // A scripted block gets one last say before its cell is wiped: `on_break`
  // still reads its own memory, can toast and log, can move the player, and its
  // store is handed to the breaker (this engine has no ground drops, so a cell's
  // items go straight into the stack that broke it). A failing hook does NOT
  // stop the break — the block is broken either way; the player just hears the
  // interpreter's message, the same way a broken menu does.
  const scriptRow = await env.DB.prepare("SELECT script FROM blocks WHERE id=?").bind(current)
    .first<{ script: string | null }>();
  let run: ScriptOutcome | null = null;
  let contents: { item: string; qty: number }[];
  if (scriptRow?.script) {
    const rows = await env.DB.prepare("SELECT key,value FROM block_state WHERE server_id=? AND x=? AND y=? AND z=?")
      .bind(server, x, y, z).all<{ key: string; value: string | null }>();
    const values = new Map<string, string | number | null>();
    for (const row of rows.results) values.set(row.key, stateValue(row.value));
    const [inv, stacks, pos] = await Promise.all([
      loadBlockInventory(env, server, x, y, z),
      loadStacks(env, auth.user.id),
      loadPlayerPosition(env, server, auth.user.id)
    ]);
    run = runBlockScript(
      scriptRow.script,
      "on_break",
      { player: auth.user.username, x, y, z },
      // The cell dies with its memory: the hook may read it, writes go with it.
      { get: (k) => values.get(k) ?? null, set: () => { /* dropped with the row */ } },
      { inv, stacks, pos, missingEntryIsNoop: true }
    );
    if (!run.ok) console.error(`on_break failed for ${current} at ${x},${y},${z}: ${run.error}`);
    // What the cell ends up holding is what the breaker takes: the store as the
    // hook left it, or the preloaded one when there was no hook to run.
    contents = run.stored.length > 0
      ? run.stored.filter((s) => s.qty > 0)
      : [...inv].map(([item, qty]) => ({ item, qty }));
  } else {
    contents = [...await loadBlockInventory(env, server, x, y, z)].map(([item, qty]) => ({ item, qty }));
  }

  const beam = await env.DB.prepare("SELECT colour FROM block_beams WHERE server_id=? AND x=? AND y=? AND z=?")
    .bind(server, x, y, z).first<{ colour: string }>();

  // One write per item for everything the breaker ends up holding — the ordinary
  // drop, whatever the hook handed over, and the contents of the cell — so two
  // grants of the same id can never clobber each other. A scripted block's
  // memory belongs to the cell: breaking it clears state, light column and store
  // together, and takes the column down on every connected client.
  await env.DB.batch([
    ...stackStatements(
      env, auth.user.id,
      [{ item: dropId, qty: 1 }, ...contents, ...(run?.gives ?? [])],
      run?.takes ?? []
    ),
    env.DB.prepare(
      "INSERT INTO world_edits(server_id,x,y,z,block_id,placed_by) VALUES(?,?,?,?,?,?) ON CONFLICT(server_id,x,y,z) DO UPDATE SET block_id='air', placed_by=excluded.placed_by, created_at=CURRENT_TIMESTAMP"
    ).bind(server, x, y, z, "air", auth.user.id),
    env.DB.prepare("INSERT INTO world_log(server_id,x,y,z,block_id) VALUES(?,?,?,?,?)").bind(server, x, y, z, "air"),
    env.DB.prepare("DELETE FROM world_log WHERE server_id=? AND seq <= (SELECT MAX(seq) - ? FROM world_log WHERE server_id=?)").bind(server, WORLD_LOG_KEEP, server),
    env.DB.prepare("DELETE FROM block_state WHERE server_id=? AND x=? AND y=? AND z=?").bind(server, x, y, z),
    env.DB.prepare("DELETE FROM block_beams WHERE server_id=? AND x=? AND y=? AND z=?").bind(server, x, y, z),
    env.DB.prepare("DELETE FROM block_inventory WHERE server_id=? AND x=? AND y=? AND z=?").bind(server, x, y, z)
  ]);
  await publishEdit(env, server, x, y, z, "air");
  if (beam) await publishFrame(env, server, { type: "beam", x, y, z, colour: null });

  // A hook's teleports and anchors belong to the player, not the dying cell.
  if (run) await applyScriptMoves(env, server, auth.user.id, auth.user.username, run.moves);

  return json({ ok: true, x, y, z, dropped: dropId, contents, toasts: run?.toasts ?? [] }, 200, origin);
}

// The admin's repair switch: re-run the edit table. D1's `world_edits` is the
// whole truth about the world, so the repair is to prune everything derived that
// lost its cell, replay the surviving cells to every connected player, and tell
// each client to rebuild its own view from the snapshot — which also clears
// blocks the client painted that the database never had. Same exact-username
// gate as the other admin tools.
const RESYNC_MAX_CELLS = 20_000;
const RESYNC_CHUNK = 2_000;

async function handleWorldResync(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  if (!isAdminUser(auth.user.username)) return err("Only the admin account can resync the world.", 403, origin);
  // Repair is per world now: an admin healing a stray overlay in one server
  // must not replay (or prune) another account's world.
  const data = await body<{ server?: unknown }>(request);
  const server = serverOf(request, data.server);
  const denied = await gateServer(request, env, server, auth, origin);
  if (denied) return denied;

  const cleared = await pruneOrphanWorldRows(env, server);
  const { results } = await env.DB
    .prepare("SELECT x,y,z,block_id FROM world_edits WHERE server_id=? ORDER BY x,y,z LIMIT ?")
    .bind(server, RESYNC_MAX_CELLS + 1).all<EditRow>();
  const truncated = results.length > RESYNC_MAX_CELLS;
  const cells = results.slice(0, RESYNC_MAX_CELLS);
  const beams = await listBeams(env, server);
  const stub = env.WORLD_LIVE.get(env.WORLD_LIVE.idFromName(server));
  for (let i = 0; i < Math.max(cells.length, 1); i += RESYNC_CHUNK) {
    await stub.fetch(new Request("https://world-live.internal/replay", {
      method: "POST",
      body: JSON.stringify({
        server,
        cells: cells.slice(i, i + RESYNC_CHUNK),
        beams: i === 0 ? beams : [],
        announce: i + RESYNC_CHUNK >= cells.length
      })
    }));
  }
  return json({
    ok: true,
    replayed: cells.length,
    truncated,
    beams: beams.length,
    stale: cleared
  }, 200, origin);
}

// ---- scripted blocks ---------------------------------------------------------
// A block's `script` is sandboxed Lua (see lua.ts) that runs here, never in the
// browser. State belongs to the cell: the script only ever sees the (x,y,z) the
// player is standing in front of, so one beacon's colour can never read or
// write another's. A light column the script switches on is persisted in
// block_beams so a player joining later sees it without re-running anything.

type BeamRow = { x: number; y: number; z: number; colour: string };

async function listBeams(env: Env, server: string): Promise<BeamRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT x,y,z,colour FROM block_beams WHERE server_id=? ORDER BY x,y,z LIMIT 400"
  ).bind(server).all<BeamRow>();
  return results;
}

// D1 stores state as text; numbers come back as numbers so a script that did
// `state_set("n", 3)` reads `3` rather than "3".
function stateValue(raw: string | null): string | number | null {
  if (raw === null) return null;
  return raw !== "" && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
}

// The interpreter never touches the database, so a run's effects on the world —
// teleports, respawn anchors, item handouts, the cell's own store — are
// preloaded before the run and flushed by the caller afterwards, in the same
// batch as everything else that request writes.

async function loadBlockInventory(env: Env, server: string, x: number, y: number, z: number): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(
    "SELECT item_id,quantity FROM block_inventory WHERE server_id=? AND x=? AND y=? AND z=?"
  ).bind(server, x, y, z).all<{ item_id: string; quantity: number }>();
  const inv = new Map<string, number>();
  for (const row of results) inv.set(row.item_id, Math.max(0, Math.min(MAX_STACK, Number(row.quantity))));
  return inv;
}

async function loadStacks(env: Env, userId: string): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare("SELECT item_id,quantity FROM inventories WHERE user_id=?")
    .bind(userId).all<{ item_id: string; quantity: number }>();
  const stacks = new Map<string, number>();
  for (const row of results) stacks.set(row.item_id, Number(row.quantity));
  return stacks;
}

async function loadPlayerPosition(env: Env, server: string, userId: string): Promise<{ x: number; y: number; z: number } | null> {
  const row = await env.DB.prepare("SELECT x,y,z FROM player_state WHERE user_id=? AND server_id=?").bind(userId, server)
    .first<{ x: number; y: number; z: number }>();
  return row ? { x: Number(row.x), y: Number(row.y), z: Number(row.z) } : null;
}

// The cell's final store as written statements: quantity 0 means the row goes.
function storeStatements(
  env: Env,
  server: string,
  x: number, y: number, z: number,
  stored: { item: string; qty: number }[]
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const s of stored) {
    if (s.qty <= 0) {
      stmts.push(env.DB.prepare(
        "DELETE FROM block_inventory WHERE server_id=? AND x=? AND y=? AND z=? AND item_id=?"
      ).bind(server, x, y, z, s.item));
    } else {
      stmts.push(env.DB.prepare(
        "INSERT INTO block_inventory(server_id,x,y,z,item_id,quantity,updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(server_id,x,y,z,item_id) DO UPDATE SET quantity=excluded.quantity, updated_at=CURRENT_TIMESTAMP"
      ).bind(server, x, y, z, s.item, s.qty));
    }
  }
  return stmts;
}

// Gives and takes on the same item cancel to ONE upsert, so two script effects
// can never clobber each other inside one batch.
function stackStatements(
  env: Env,
  userId: string,
  gives: { item: string; qty: number }[],
  takes: { item: string; qty: number }[]
): D1PreparedStatement[] {
  const delta = new Map<string, number>();
  for (const g of gives) delta.set(g.item, (delta.get(g.item) ?? 0) + g.qty);
  for (const t of takes) delta.set(t.item, (delta.get(t.item) ?? 0) - t.qty);
  const stmts: D1PreparedStatement[] = [];
  for (const [item, d] of delta) {
    if (d > 0) {
      stmts.push(env.DB.prepare(
        "INSERT INTO inventories(user_id,item_id,quantity) VALUES(?,?,?) ON CONFLICT(user_id,item_id) DO UPDATE SET quantity=MIN(?,quantity+?), updated_at=CURRENT_TIMESTAMP"
      ).bind(userId, item, Math.min(MAX_STACK, d), MAX_STACK, d));
    } else if (d < 0) {
      stmts.push(env.DB.prepare(
        "UPDATE inventories SET quantity=MAX(0,quantity+?), updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND item_id=?"
      ).bind(d, userId, item));
    }
  }
  return stmts;
}

// Teleports and anchors outlive the request that wrote them: the live object
// must hear about a move, or its cached presence would push the player back.
async function applyScriptMoves(
  env: Env,
  server: string,
  userId: string,
  username: string,
  moves: { kind: "position" | "respawn"; x: number; y: number; z: number }[]
): Promise<void> {
  for (const m of moves) {
    if (m.kind === "respawn") {
      // The insert side has to be a complete row: x/y/z are NOT NULL, and
      // SQLite checks them even when the row already exists and the update side
      // runs. Only a player who has never moved takes these defaults.
      const fresh = defaultSpawnState(username);
      await env.DB.prepare(
        "INSERT INTO player_state(user_id,server_id,x,y,z,yaw,pitch,health,spawn_x,spawn_y,spawn_z)" +
        " SELECT id,?,?,?,?,0,0,20,?,?,? FROM users WHERE id=?" +
        " ON CONFLICT(user_id, server_id) DO UPDATE SET spawn_x=excluded.spawn_x, spawn_y=excluded.spawn_y, spawn_z=excluded.spawn_z, updated_at=CURRENT_TIMESTAMP"
      ).bind(server, fresh.x, fresh.y, fresh.z, m.x, m.y, m.z, userId).run();
      continue;
    }
    await env.DB.prepare(
      "INSERT INTO player_state(user_id,server_id,x,y,z,yaw,pitch,health) SELECT id,?,?,?,?,0,0,? FROM users WHERE id=?" +
      " ON CONFLICT(user_id, server_id) DO UPDATE SET x=excluded.x, y=excluded.y, z=excluded.z, yaw=0, pitch=0, updated_at=CURRENT_TIMESTAMP"
    ).bind(server, m.x, m.y, m.z, MAX_HEALTH, userId).run();
    await notifyLive(env, server, "move", { name: username, x: m.x, y: m.y, z: m.z });
  }
}

async function handleBlockInteract(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  const data = await body<{ x: unknown; y: unknown; z: unknown; key?: unknown; server?: unknown }>(request);
  const server = serverOf(request, data.server);
  const denied = await gateServer(request, env, server, auth, origin);
  if (denied) return denied;
  const coords = worldCoords(data);
  if (!coords) return err(`Coordinates must be integers (x/z within ±${WORLD_COORD_LIMIT}, y within 0..${WORLD_Y - 1}).`, 400, origin);
  const { x, y, z } = coords;
  // No key means "open the block's menu"; a key means "choose this option".
  const key = typeof data.key === "string" && data.key ? data.key.slice(0, 32) : undefined;

  const cells = await resolveCells(env, server, [[x, y, z]]);
  const blockId = cells.get(cellKey(x, y, z))!;
  if (blockId === "air") return json({ ok: false, reason: "empty" }, 200, origin);
  const block = await env.DB.prepare("SELECT id,name,script FROM blocks WHERE id=?")
    .bind(blockId).first<{ id: string; name: string; script: string | null }>();
  if (!block || !block.script) return json({ ok: false, reason: "unscripted" }, 200, origin);

  // The interpreter reads and writes state synchronously, so the cell's rows
  // are preloaded and the writes are flushed afterwards.
  const stored = await env.DB.prepare("SELECT key,value FROM block_state WHERE server_id=? AND x=? AND y=? AND z=?")
    .bind(server, x, y, z).all<{ key: string; value: string | null }>();
  const values = new Map<string, string | number | null>();
  for (const row of stored.results) values.set(row.key, stateValue(row.value));
  const writes = new Map<string, string | number | null>();
  const state: ScriptState = {
    get: k => (values.has(k) ? values.get(k)! : null),
    set: (k, v) => { writes.set(k, v); values.set(k, v); },
  };

  const before = await env.DB.prepare("SELECT colour FROM block_beams WHERE server_id=? AND x=? AND y=? AND z=?")
    .bind(server, x, y, z).first<{ colour: string }>();

  // Same preload/flush shape for the rest of the world the script can touch:
  // the acting player's position and stacks, and this cell's own store.
  const [inv, stacks, pos] = await Promise.all([
    loadBlockInventory(env, server, x, y, z),
    loadStacks(env, auth.user.id),
    loadPlayerPosition(env, server, auth.user.id)
  ]);

  const outcome = runBlockScript(
    block.script,
    key ? "on_choice" : "on_interact",
    { player: auth.user.username, key, x, y, z },
    state,
    { inv, stacks, pos }
  );
  if (!outcome.ok) {
    // A broken script is the author's bug, not the player's — say so plainly
    // rather than pretending the block did nothing. Nothing from a failed run
    // is applied: no state, no beams, no items, no moves.
    return json({ ok: false, reason: "script-error", error: outcome.error ?? "Script failed." }, 200, origin);
  }

  const flush: D1PreparedStatement[] = [];
  for (const [k, v] of writes) {
    if (v === null) flush.push(env.DB.prepare("DELETE FROM block_state WHERE server_id=? AND x=? AND y=? AND z=? AND key=?").bind(server, x, y, z, k));
    else flush.push(env.DB.prepare(
      "INSERT INTO block_state(server_id,x,y,z,key,value,updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(server_id,x,y,z,key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP"
    ).bind(server, x, y, z, k, String(v)));
  }
  flush.push(...storeStatements(env, server, x, y, z, outcome.stored));
  flush.push(...stackStatements(env, auth.user.id, outcome.gives, outcome.takes));
  flush.push(env.DB.prepare("DELETE FROM block_beams WHERE server_id=? AND x=? AND y=? AND z=?").bind(server, x, y, z));
  const beams: string[] = [];
  for (const beam of outcome.beams) {
    if (!/^#[0-9a-f]{6}$/i.test(beam.colour)) continue;
    flush.push(env.DB.prepare("INSERT INTO block_beams(server_id,x,y,z,colour,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(server_id,x,y,z) DO UPDATE SET colour=excluded.colour, updated_at=CURRENT_TIMESTAMP")
      .bind(server, x, y, z, beam.colour));
    beams.push(beam.colour);
  }
  await env.DB.batch(flush);

  // Live light: every client watching THIS world paints (or removes) the cell's
  // column.
  if (beams.length) await publishFrame(env, server, { type: "beam", x, y, z, colour: beams[beams.length - 1] });
  else if (before) await publishFrame(env, server, { type: "beam", x, y, z, colour: null });

  // The player's own world moved: write it and let the live object know, or the
  // next presence frame would shove them back to where they were.
  await applyScriptMoves(env, server, auth.user.id, auth.user.username, outcome.moves);

  return json({
    ok: true,
    name: block.name,
    title: outcome.menu?.title ?? null,
    menu: outcome.menu?.options ?? null,
    toasts: outcome.toasts,
    moved: outcome.moves.length > 0,
    items: outcome.gives.length + outcome.takes.length > 0
  }, 200, origin);
}

// ---- player state: server-persisted position + look -------------------------

type AppearanceColours = { body_colour: string; head_colour: string; accent_colour: string; eye_colour: string };

// Used when a player has never saved an appearance.
const DEFAULT_APPEARANCE: AppearanceColours = { body_colour: "#3b6ea5", head_colour: "#d9a06b", accent_colour: "#2f8f4f", eye_colour: "#1d2430" };

async function handleGetPlayerState(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  const server = serverOf(request);
  const denied = await gateServer(request, env, server, auth, origin);
  if (denied) return denied;
  const [row, appearance] = await Promise.all([
    env.DB
      .prepare("SELECT x, y, z, yaw, pitch, health FROM player_state WHERE user_id=? AND server_id=?")
      .bind(auth.user.id, server)
      .first<{ x: number; y: number; z: number; yaw: number; pitch: number; health: number }>(),
    env.DB
      .prepare("SELECT body_colour, head_colour, accent_colour, eye_colour FROM player_appearance WHERE user_id=?")
      .bind(auth.user.id)
      .first<AppearanceColours>()
  ]);
  const stored = row ? Math.max(0, Math.min(MAX_HEALTH, Number(row.health))) : MAX_HEALTH;
  return json({
    state: row ? { x: row.x, y: row.y, z: row.z, yaw: row.yaw, pitch: row.pitch } : null,
    appearance: appearance ?? DEFAULT_APPEARANCE,
    health: Number.isFinite(stored) ? stored : MAX_HEALTH
  }, 200, origin);
}

async function handlePutPlayerState(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  const data = await body<{ x: unknown; y: unknown; z: unknown; yaw: unknown; pitch: unknown; server?: unknown }>(request);
  const server = serverOf(request, data.server);
  const denied = await gateServer(request, env, server, auth, origin);
  if (denied) return denied;
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const x = n(data.x), y = n(data.y), z = n(data.z), yaw = n(data.yaw), pitch = n(data.pitch);
  if (x === null || y === null || z === null || yaw === null || pitch === null)
    return err("x, y, z, yaw and pitch must be finite numbers.", 400, origin);
  if (Math.abs(x) > 1e6 || Math.abs(z) > 1e6 || y < 0 || y > 256)
    return err("Position is outside the world.", 400, origin);
  await env.DB.prepare(
    "INSERT INTO player_state(user_id,server_id,x,y,z,yaw,pitch) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id, server_id) DO UPDATE SET x=excluded.x, y=excluded.y, z=excluded.z, yaw=excluded.yaw, pitch=excluded.pitch, updated_at=CURRENT_TIMESTAMP"
  ).bind(auth.user.id, server, x, y, z, yaw, pitch).run();
  return json({ ok: true }, 200, origin);
}

// Character appearance: one upserted row per user; colours join the live
// presence frames so other players render your avatar in your colours.
async function handlePostPlayerAppearance(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  const data = await body<{ body_colour: unknown; head_colour: unknown; accent_colour: unknown; eye_colour: unknown }>(request);
  const appearance: AppearanceColours = {
    body_colour: String(data.body_colour ?? ""),
    head_colour: String(data.head_colour ?? ""),
    accent_colour: String(data.accent_colour ?? ""),
    eye_colour: String(data.eye_colour ?? "")
  };
  if (!validColour(appearance.body_colour) || !validColour(appearance.head_colour) || !validColour(appearance.accent_colour) || !validColour(appearance.eye_colour))
    return err("Invalid appearance colours.", 400, origin);
  await env.DB.prepare(
    "INSERT INTO player_appearance(user_id,body_colour,head_colour,accent_colour,eye_colour) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET body_colour=excluded.body_colour, head_colour=excluded.head_colour, accent_colour=excluded.accent_colour, eye_colour=excluded.eye_colour, updated_at=CURRENT_TIMESTAMP"
  ).bind(auth.user.id, appearance.body_colour, appearance.head_colour, appearance.accent_colour, appearance.eye_colour).run();
  return json(appearance, 200, origin);
}

async function handleCraft(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  const data = await body<{ recipe_id: unknown }>(request);
  const recipeId = typeof data.recipe_id === "string" ? data.recipe_id : "";
  if (!/^[0-9a-f-]{36}$/i.test(recipeId)) return err("Invalid recipe id.", 400, origin);

  const recipe = await env.DB.prepare("SELECT id,name,ingredients_json,result_id,quantity FROM recipes WHERE id=?").bind(recipeId).first<RecipeRow>();
  if (!recipe) return err("Recipe not found.", 404, origin);

  const resultRegistered = await env.DB.prepare("SELECT id FROM items WHERE id=?").bind(recipe.result_id).first();
  if (!resultRegistered)
    return json({ error: `The result "${recipe.result_id}" is not in the item registry, so it cannot be crafted.`, code: "unknown_result" }, 409, origin);

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

// ---- player health: respawn + eating ----------------------------------------

// The default spawn handleGetPlayerState falls back to: a stateless player
// stands on the terrain surface at the world origin column — x/z 0.5, y =
// surface top + eye height (EYE 1.7 in the client camera).
// Every account that has never moved, and every anchor-less respawn, used to
// wake up on the same cell - two players who joined together stood inside each
// other's camera. The column comes from the account name and only where the
// ground is as flat as the origin's; the client's ring in
// `frontend/dve/src/main.js` is the same table, so both sides spread the same
// way.
const SPAWN_SPREAD: [number, number][] = [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, 2],
  [2, -2], [-2, -2], [5, 0], [-5, 0], [0, 5], [0, -5], [4, 3], [-4, 3], [4, -3], [-4, -3], [7, 0], [-7, 0], [0, 7], [0, -7]];

function spawnColumn(username: string): { x: number; z: number } {
  let h = 2166136261;
  for (let i = 0; i < username.length; i++) { h ^= username.charCodeAt(i); h = Math.imul(h, 16777619); }
  const base = heightAt(0, 0);
  for (let k = 0; k < SPAWN_SPREAD.length; k++) {
    const c = SPAWN_SPREAD[((h >>> 1) + k) % SPAWN_SPREAD.length];
    if (Math.abs(heightAt(c[0], c[1]) - base) <= 1) return { x: 0.5 + c[0], z: 0.5 + c[1] };
  }
  return { x: 0.5, z: 0.5 };
}

function defaultSpawnState(username = ""): { x: number; y: number; z: number; yaw: number; pitch: number } {
  const at = spawnColumn(username);
  return { x: at.x, y: heightAt(Math.floor(at.x), Math.floor(at.z)) + 1 + 1.7, z: at.z, yaw: 0, pitch: 0 };
}

async function handleRespawn(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  const data = await body<{ server?: unknown }>(request);
  const server = serverOf(request, data.server);
  const denied = await gateServer(request, env, server, auth, origin);
  if (denied) return denied;
  // Where a player wakes up is theirs to lose and to win back: `defaultSpawnState`
  // is the fallback, a script's `set_player_respawn_position` is the anchor.
  const anchor = await env.DB.prepare("SELECT spawn_x,spawn_y,spawn_z FROM player_state WHERE user_id=? AND server_id=?")
    .bind(auth.user.id, server).first<{ spawn_x: number | null; spawn_y: number | null; spawn_z: number | null }>();
  // Number(null) is 0, which would wake every player who never set an anchor at
  // the bottom of the world: an anchor exists only when the column holds a
  // number.
  const at = [anchor?.spawn_x, anchor?.spawn_y, anchor?.spawn_z]
    .map(v => v === null || v === undefined ? null : Number(v));
  const state = at.every(v => v !== null && Number.isFinite(v))
    ? { x: at[0]!, y: at[1]!, z: at[2]!, yaw: 0, pitch: 0 }
    : defaultSpawnState(auth.user.username);
  await env.DB.prepare(
    `INSERT INTO player_state(user_id,server_id,x,y,z,yaw,pitch,health) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, server_id) DO UPDATE SET x=excluded.x, y=excluded.y, z=excluded.z,
       yaw=excluded.yaw, pitch=excluded.pitch, health=excluded.health, updated_at=CURRENT_TIMESTAMP`
  ).bind(auth.user.id, server, state.x, state.y, state.z, state.yaw, state.pitch, MAX_HEALTH).run();
  // The live object clears the dead flag and pushes a respawn frame so the
  // player's sockets and the simulation agree immediately.
  await notifyLive(env, server, "respawn", { name: auth.user.username, health: MAX_HEALTH, state });
  // ...and its cached presence moves with them, or the body would keep standing
  // where they died for everyone else.
  await notifyLive(env, server, "move", { name: auth.user.username, x: state.x, y: state.y, z: state.z });
  return json({ ok: true, health: MAX_HEALTH, state }, 200, origin);
}

async function handleEat(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  // The client's eat call names no server (health is the only scoped field it
  // touches here), so this keeps landing in `global` — the derivation is here
  // for when it ever does.
  const data = await body<{ item_id: unknown; server?: unknown }>(request);
  const server = serverOf(request, data.server);
  const itemId = typeof data.item_id === "string" ? data.item_id.trim() : "";
  if (!validItemId(itemId)) return err("Invalid item ID.", 400, origin);
  const item = await env.DB.prepare("SELECT kind, heal FROM items WHERE id=?").bind(itemId).first<{ kind: string; heal: number }>();
  if (!item || item.kind !== "food" || !(item.heal > 0)) return err(`You cannot eat ${itemId}.`, 400, origin);
  const debit = await env.DB.prepare(
    "UPDATE inventories SET quantity=quantity-1, updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND item_id=? AND quantity>=1"
  ).bind(auth.user.id, itemId).run();
  if (!debit.meta.changes) return err(`You have no ${itemId} to eat.`, 400, origin);
  await env.DB.prepare("DELETE FROM inventories WHERE user_id=? AND item_id=? AND quantity<=0").bind(auth.user.id, itemId).run();
  const row = await env.DB.prepare("SELECT health FROM player_state WHERE user_id=? AND server_id=?").bind(auth.user.id, server).first<{ health: number }>();
  const current = row ? Math.max(0, Math.min(MAX_HEALTH, Number(row.health) || 0)) : MAX_HEALTH;
  const health = Math.min(MAX_HEALTH, current + item.heal);
  await env.DB.prepare(
    `INSERT INTO player_state(user_id,server_id,x,y,z,yaw,pitch,health)
     SELECT id, ?, ?, ?, ?, 0, 0, ? FROM users WHERE id = ?
     ON CONFLICT(user_id, server_id) DO UPDATE SET health=excluded.health, updated_at=CURRENT_TIMESTAMP`
  ).bind(server, 0.5, heightAt(0, 0) + 2.7, 0.5, health, auth.user.id).run();
  await notifyLive(env, server, "health", { name: auth.user.username, health });
  return json({ ok: true, health }, 200, origin);
}

// ---- The world's clock ------------------------------------------------------
// Anyone in the world may read it (a client needs the phase before it can draw
// a sky); only the admin may dial it. `phase` is the fraction of the in-game day
// (0 = midnight, 0.5 = noon) taken at `epoch_ms`; a client derives
// `phase + (Date.now() - epoch_ms) / DAY_MS`, or just `phase` while `running` is
// false. `phase: null` hands the clock back to the sun — every client then reads
// the same phase off its own wall clock, which is how the cycle ran before
// anybody owned it.
async function readWorldClock(env: Env, server: string): Promise<{ phase: number | null; epoch: number; running: boolean }> {
  const { results } = await env.DB
    .prepare("SELECT phase, epoch_ms, running FROM world_clock WHERE id=1 AND server_id=?")
    .bind(server)
    .all<{ phase: number | null; epoch_ms: number; running: number }>();
  const row = results[0];
  return {
    phase: row?.phase === null || row?.phase === undefined ? null : Number(row.phase),
    epoch: Number(row?.epoch_ms) || 0,
    running: (row?.running ?? 1) !== 0
  };
}

async function handleGetTime(request: Request, env: Env, origin: string | null): Promise<Response> {
  const server = serverOf(request);
  // Reading a stranger's sky is exactly as gated as standing in their world;
  // with no session the private rule still opens for the creating device.
  const auth = server === GLOBAL_SERVER ? null : await authenticate(request, env);
  const denied = await gateServer(request, env, server, auth, origin);
  if (denied) return denied;
  return json(await readWorldClock(env, server), 200, origin);
}

async function handleSetTime(request: Request, env: Env, origin: string | null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth) return err("Log in first.", 401, origin);
  const data = await body<{ phase: unknown; running: unknown; reset: unknown; server?: unknown }>(request);
  const server = serverOf(request, data.server);
  const denied = await gateServer(request, env, server, auth, origin);
  if (denied) return denied;
  // Dial authority: the site admin for every world; for their own servers also
  // the owner. `global` has no owner column to consult, so it stays admin-only.
  if (!isAdminUser(auth.user.username)) {
    if (server === GLOBAL_SERVER) return err("Only the admin account can set the time of day.", 403, origin);
    const owned = await env.DB.prepare("SELECT owner FROM servers WHERE id=?").bind(server).first<{ owner: string }>();
    if (!owned || owned.owner !== auth.user.username) return err("Only the admin account or the server's owner can set the time of day.", 403, origin);
  }
  const handBack = async (): Promise<Response> => {
    await env.DB.prepare("DELETE FROM world_clock WHERE id=1 AND server_id=?").bind(server).run();
    const clock = { phase: null, epoch: 0, running: true };
    await notifyLive(env, server, "clock", clock);
    return json({ ok: true, ...clock }, 200, origin);
  };
  if (data.reset === true) return handBack();

  const current = await readWorldClock(env, server);
  let phase = current.phase;
  if (data.phase !== undefined && data.phase !== null) {
    const p = Number(data.phase);
    if (!Number.isFinite(p) || p < 0 || p >= 1) return err("phase must be a fraction of the day: 0 to 0.999.", 400, origin);
    phase = p;
  }
  const running = data.running === undefined ? current.running : !!data.running;
  // Stop is only worth storing next to a phase; dialling nothing and running is
  // the same world as no row at all.
  if (phase === null && running) return handBack();

  const epoch = Date.now();
  await env.DB.prepare(
    `INSERT INTO world_clock (id,server_id,phase,epoch_ms,running,set_by,set_at) VALUES (1,?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(id, server_id) DO UPDATE SET phase=excluded.phase, epoch_ms=excluded.epoch_ms, running=excluded.running,
       set_by=excluded.set_by, set_at=excluded.set_at`
  ).bind(server, phase, epoch, running ? 1 : 0, auth.user.username).run();
  await notifyLive(env, server, "clock", { phase, epoch, running });
  return json({ ok: true, phase, epoch, running }, 200, origin);
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
        // `models` is the vocabulary the Studio can offer; the renderer falls
        // back to a plain cube for anything else, so a stale client can never
        // be bricked by a published block.
        return json({ blocks: await listBlocks(env), models: [...BLOCK_MODELS] }, 200, origin);
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
        const appearance = sanitizeImage(data.texture, 60_000, "Block texture");
        if (appearance.error) return err(appearance.error, 400, origin);
        const topFace = sanitizeImage(data.texture_top, 60_000, "Top texture");
        if (topFace.error) return err(topFace.error, 400, origin);
        const bottomFace = sanitizeImage(data.texture_bottom, 60_000, "Bottom texture");
        if (bottomFace.error) return err(bottomFace.error, 400, origin);
        const model = sanitizeModel(data.model);
        if (model.error) return err(model.error, 400, origin);
        const script = sanitizeScript(data.script);
        if (script.error) return err(script.error, 400, origin);
        // Registry ID: player:USERNAME:NAMESPACE:BLOCKNAME — the display name
        // (name) is separate, exactly like builtins (builtin:grass / "Grass").
        const fullId = `player:${auth.user.username.toLowerCase()}:${namespace.toLowerCase()}:${id.toLowerCase()}`;
        try {
          await env.DB.prepare(
            "INSERT INTO blocks(id,name,creator_id,creator_name,hardness,light,colour,behaviour,rules_json,is_builtin,texture,texture_top,texture_bottom,model,script) VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)"
          ).bind(fullId, name, auth.user.id, auth.user.username, hardness, light, colour, behaviour, JSON.stringify(rules),
            appearance.value, topFace.value, bottomFace.value, model.value, script.value).run();
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
        const appearance = sanitizeImage(data.texture, 60_000, "Block texture");
        if (appearance.error) return err(appearance.error, 400, origin);
        const topFace = sanitizeImage(data.texture_top, 60_000, "Top texture");
        if (topFace.error) return err(topFace.error, 400, origin);
        const bottomFace = sanitizeImage(data.texture_bottom, 60_000, "Bottom texture");
        if (bottomFace.error) return err(bottomFace.error, 400, origin);
        const model = sanitizeModel(data.model);
        if (model.error) return err(model.error, 400, origin);
        const script = sanitizeScript(data.script);
        if (script.error) return err(script.error, 400, origin);
        await env.DB.prepare(
          "UPDATE blocks SET name=?,hardness=?,light=?,colour=?,behaviour=?,rules_json=?,texture=?,texture_top=?,texture_bottom=?,model=?,script=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
        ).bind(name, hardness, light, colour, behaviour, JSON.stringify(rules),
          appearance.value, topFace.value, bottomFace.value, model.value, script.value, id).run();
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
          "SELECT x,y,z,server_id FROM world_edits WHERE block_id=?"
        ).bind(id).all<{ x: number; y: number; z: number; server_id: string }>();
        const recipes = await env.DB.prepare(
          "SELECT ingredients_json FROM recipes WHERE result_id=? OR ingredients_json LIKE ?"
        ).bind(id, `%"${id}"%`).all<{ ingredients_json: string }>();
        await env.DB.prepare("DELETE FROM world_edits WHERE block_id=?").bind(id).run();
        await env.DB.prepare("DELETE FROM recipes WHERE result_id=? OR ingredients_json LIKE ?")
          .bind(id, `%"${id}"%`).run();
        // The edits are gone, so the log rows, script memory and light columns
        // that pointed at them are stale the same instant — in EVERY world the
        // block was standing in, so pruning and publishing are per server.
        const servers = [...new Set(placed.results.map(row => row.server_id))];
        let stale = { log: 0, state: 0, beams: 0, inv: 0 };
        for (const server of servers) {
          const counts = await pruneOrphanWorldRows(env, server);
          stale = { log: stale.log + counts.log, state: stale.state + counts.state, beams: stale.beams + counts.beams, inv: stale.inv + counts.inv };
        }
        for (const cell of placed.results) {
          await publishEdit(env, cell.server_id, cell.x, cell.y, cell.z, "air");
        }
        await env.DB.prepare("DELETE FROM blocks WHERE id=?").bind(id).run();
        // Stale inventory stacks for a block that no longer exists are dead weight.
        await env.DB.prepare("DELETE FROM inventories WHERE item_id=?").bind(id).run();
        return json({
          ok: true,
          cleared: { placed: placed.results.length, recipes: recipes.results.length, ...stale },
        }, 200, origin);
      }

      // ---- Items: what players hold; 'block' items programme a block --------
      if (path === "/api/items" && request.method === "GET") {
        return json({ items: await listItems(env) }, 200, origin);
      }

      if (path === "/api/items" && request.method === "POST") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const data = await body<any>(request);
        const name = String(data.name || "").trim();
        const id = String(data.id || "").trim();
        // Optional for symmetry with the block workshop; defaults to "default".
        const namespace = String(data.namespace || "default").trim();
        const kind = String(data.kind || "");
        const colour = String(data.colour || "");
        if (name.length < 1 || name.length > 40) return err("Item name must be 1–40 characters.", 400, origin);
        if (!/^[A-Za-z0-9_]{1,24}$/.test(namespace)) return err("Namespace must be 1–24 characters (letters, numbers, underscores).", 400, origin);
        if (!/^[A-Za-z0-9_]{1,24}$/.test(id)) return err("Use a simple ID (letters, numbers and underscores).", 400, origin);
        if (!itemKinds.has(kind)) return err("Kind must be one of: block, tool, weapon, food, material.", 400, origin);
        if (!validColour(colour)) return err("Invalid colour.", 400, origin);
        const stats = itemStatsFromInput(data);
        if (!stats) return err("Invalid item stats (damage 0–50, speed 0.1–10, heal 0–20, durability 0–1000).", 400, origin);
        const programme = await programmeFromInput(env, kind, data.place_block_id);
        if (programme.error) return err(programme.error, 400, origin);
        const icon = sanitizeImage(data.icon, 40_000, "Item icon");
        if (icon.error) return err(icon.error, 400, origin);
        // Registry ID: player:USERNAME:NAMESPACE:ITEMNAME — same shape as blocks.
        const fullId = `player:${auth.user.username.toLowerCase()}:${namespace.toLowerCase()}:${id.toLowerCase()}`;
        try {
          await env.DB.prepare(
            "INSERT INTO items(id,name,creator_id,creator_name,kind,place_block_id,damage,speed,heal,durability,colour,is_builtin,icon) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)"
          ).bind(fullId, name, auth.user.id, auth.user.username, kind, programme.placeBlockId,
                 stats.damage, stats.speed, stats.heal, stats.durability, colour, icon.value).run();
        } catch {
          return err("That item ID already exists.", 409, origin);
        }
        return json({ ok: true, id: fullId }, 201, origin);
      }

      const itemMatch = path.match(/^\/api\/items\/(.+)$/);
      if (itemMatch && request.method === "PUT") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const id = decodeURIComponent(itemMatch[1]);
        const data = await body<any>(request);
        const existing = await env.DB.prepare(
          "SELECT creator_id,is_builtin FROM items WHERE id=?"
        ).bind(id).first<any>();
        if (!existing) return err("Item not found.", 404, origin);
        if (existing.is_builtin) return err("Built-in items are immutable.", 403, origin);
        if (existing.creator_id !== auth.user.id) return err("Only the creator can edit this item.", 403, origin);
        const name = String(data.name || "").trim();
        const kind = String(data.kind || "");
        const colour = String(data.colour || "");
        if (name.length < 1 || name.length > 40 || !itemKinds.has(kind) || !validColour(colour)) {
          return err("Invalid item fields.", 400, origin);
        }
        const stats = itemStatsFromInput(data);
        if (!stats) return err("Invalid item stats (damage 0–50, speed 0.1–10, heal 0–20, durability 0–1000).", 400, origin);
        const programme = await programmeFromInput(env, kind, data.place_block_id);
        if (programme.error) return err(programme.error, 400, origin);
        const icon = sanitizeImage(data.icon, 40_000, "Item icon");
        if (icon.error) return err(icon.error, 400, origin);
        // The item's ID never changes — players already hold it, and world
        // truth is block ids, so re-programming the item is safe.
        await env.DB.prepare(
          "UPDATE items SET name=?,kind=?,place_block_id=?,damage=?,speed=?,heal=?,durability=?,colour=?,icon=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
        ).bind(name, kind, programme.placeBlockId, stats.damage, stats.speed, stats.heal, stats.durability, colour, icon.value, id).run();
        return json({ ok: true }, 200, origin);
      }

      if (itemMatch && request.method === "DELETE") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const id = decodeURIComponent(itemMatch[1]);
        const existing = await env.DB.prepare(
          "SELECT creator_id,is_builtin FROM items WHERE id=?"
        ).bind(id).first<any>();
        if (!existing) return err("Item not found.", 404, origin);
        if (existing.is_builtin) return err("Built-in items are immutable.", 403, origin);
        if (existing.creator_id !== auth.user.id) return err("Only the creator can delete this item.", 403, origin);
        // Deleting an item cascades: held stacks and referencing recipes are
        // dropped, so "delete my test item" always works without manual cleanup.
        const stacks = await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM inventories WHERE item_id=?"
        ).bind(id).first<{ count: number }>();
        const recipes = await env.DB.prepare(
          "SELECT ingredients_json FROM recipes WHERE result_id=? OR ingredients_json LIKE ?"
        ).bind(id, `%"${id}"%`).all<{ ingredients_json: string }>();
        await env.DB.prepare("DELETE FROM inventories WHERE item_id=?").bind(id).run();
        await env.DB.prepare("DELETE FROM recipes WHERE result_id=? OR ingredients_json LIKE ?")
          .bind(id, `%"${id}"%`).run();
        await env.DB.prepare("DELETE FROM items WHERE id=?").bind(id).run();
        return json({
          ok: true,
          cleared: { stacks: stacks?.count ?? 0, recipes: recipes.results.length },
        }, 200, origin);
      }

      if (path === "/api/recipes" && request.method === "GET") {
        return json({ recipes: await listRecipes(env) }, 200, origin);
      }

      if (path === "/api/recipes" && request.method === "POST") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const data = await body<unknown>(request);
        const fields = recipeFieldsFromInput(data);
        if (!fields) return err("Invalid recipe fields.", 400, origin);
        const resultItem = await env.DB.prepare("SELECT id FROM items WHERE id=?").bind(fields.result_id).first();
        if (!resultItem) return err("Recipe result must be a published item.", 400, origin);
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO recipes(id,name,creator_id,creator_name,ingredients_json,result_id,quantity) VALUES(?,?,?,?,?,?,?)"
        ).bind(id, fields.name, auth.user.id, auth.user.username, JSON.stringify(fields.ingredients), fields.result_id, fields.quantity).run();
        return json({ ok: true, id }, 201, origin);
      }

      const recipeMatch = path.match(/^\/api\/recipes\/([0-9a-f-]{36})$/i);
      if (recipeMatch && request.method === "PUT") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const id = recipeMatch[1];
        const existing = await env.DB.prepare("SELECT creator_id,name FROM recipes WHERE id=?").bind(id).first<{ creator_id: string; name: string }>();
        if (!existing) return err("Recipe not found.", 404, origin);
        if (existing.creator_id !== auth.user.id) return err("Only the creator can edit this recipe.", 403, origin);
        const data = await body<{ name?: unknown; ingredients?: unknown; result_id?: unknown; quantity?: unknown }>(request);
        // `name` is optional on edit: omitting it keeps the recipe's current name.
        const fields = recipeFieldsFromInput({ ...data, name: data.name === undefined ? existing.name : data.name });
        if (!fields) return err("Invalid recipe fields.", 400, origin);
        const resultItem = await env.DB.prepare("SELECT id FROM items WHERE id=?").bind(fields.result_id).first();
        if (!resultItem) return err("Recipe result must be a published item.", 400, origin);
        await env.DB.prepare("UPDATE recipes SET name=?,ingredients_json=?,result_id=?,quantity=? WHERE id=?")
          .bind(fields.name, JSON.stringify(fields.ingredients), fields.result_id, fields.quantity, id).run();
        return json({ ok: true }, 200, origin);
      }

      if (recipeMatch && request.method === "DELETE") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const id = recipeMatch[1];
        const existing = await env.DB.prepare("SELECT creator_id FROM recipes WHERE id=?").bind(id).first<{ creator_id: string }>();
        if (!existing) return err("Recipe not found.", 404, origin);
        if (existing.creator_id !== auth.user.id) return err("Only the creator can delete this recipe.", 403, origin);
        await env.DB.prepare("DELETE FROM recipes WHERE id=?").bind(id).run();
        return json({ ok: true }, 200, origin);
      }

      // ---- Own servers ------------------------------------------------------------
      // A server is a scoped world owned by one account. `global` is never a
      // row here: the list prepends it synthetically so the client sees the
      // shared world without the database ever needing a placeholder for it.
      if (path === "/api/servers" && request.method === "GET") {
        const auth = await authenticate(request, env);
        const { results } = await env.DB
          .prepare("SELECT id,name,owner,visibility,device_hash,host_ip FROM servers ORDER BY created_at, id")
          .all<ServerRow>();
        // Listing follows the join rules: everything public is listed, and a
        // closed world appears only for the people who could enter it.
        const device = request.headers.get("X-AC-Device") || "";
        const deviceHash = /^[0-9a-f]{32,}$/i.test(device) ? await sha256Hex(device) : "";
        const ip = clientIpOf(request);
        const servers: unknown[] = [{
          id: GLOBAL_SERVER, name: "Global", owner: "", visibility: "public",
          players: await livePlayers(env, GLOBAL_SERVER), mine: false
        }];
        for (const row of results) {
          const mine = !!auth && auth.user.username === row.owner;
          const admin = !!auth && isAdminUser(auth.user.username);
          const own = mine || admin || (!!row.device_hash && row.device_hash === deviceHash);
          const lanOpen = row.visibility === "lan" && sameLan24(ip, row.host_ip);
          if (row.visibility !== "public" && !lanOpen && !own) continue;
          servers.push({
            id: row.id, name: row.name, owner: row.owner, visibility: row.visibility,
            players: await livePlayers(env, row.id), mine
          });
        }
        return json({ servers }, 200, origin);
      }

      if (path === "/api/servers" && request.method === "POST") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const data = await body<{ name?: unknown; visibility?: unknown }>(request);
        // Error bodies here are terse tokens by contract — the client renders
        // the message, the API only names the failed rule.
        const name = String(data.name ?? "").trim();
        if (!name || name.length > 32) return err("name", 400, origin);
        const visibility = String(data.visibility ?? "");
        if (visibility !== "private" && visibility !== "lan" && visibility !== "public")
          return err("visibility", 400, origin);
        const owned = await env.DB.prepare("SELECT COUNT(*) AS n FROM servers WHERE owner=?")
          .bind(auth.user.username).first<{ n: number }>();
        if ((owned?.n ?? 0) >= MAX_SERVERS_PER_ACCOUNT) return err("limit", 409, origin);
        // What creating opens up to: the creating device's secret goes in only
        // as a hash, and the creator's IP is what the lan rule later matches.
        const device = request.headers.get("X-AC-Device") || "";
        const deviceHash = /^[0-9a-f]{32,}$/i.test(device) ? await sha256Hex(device) : null;
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO servers(id,name,owner,visibility,device_hash,host_ip) VALUES(?,?,?,?,?,?)")
          .bind(id, name, auth.user.username, visibility, deviceHash, clientIpOf(request) || null).run();
        return json({ server: { id, name, owner: auth.user.username, visibility, players: 0, mine: true } }, 201, origin);
      }

      // `global` can never be deleted — not even by the site admin: it is the
      // implicit default of every scoped table, not a row anywhere.
      if (path === "/api/servers/global" && request.method === "DELETE") return err("global", 400, origin);
      const serverMatch = path.match(/^\/api\/servers\/([0-9a-f-]{36})$/);
      if (serverMatch && request.method === "DELETE") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const id = serverMatch[1];
        const row = await env.DB.prepare("SELECT id,owner FROM servers WHERE id=?").bind(id).first<{ id: string; owner: string }>();
        if (!row) return err("server", 404, origin);
        if (row.owner !== auth.user.username && !isAdminUser(auth.user.username)) return err("owner", 403, origin);
        // Deleting a server drops its whole world: blocks, log, clock, player
        // positions, scripted memory, light columns, cell stores.
        await env.DB.batch([
          env.DB.prepare("DELETE FROM world_edits WHERE server_id=?").bind(id),
          env.DB.prepare("DELETE FROM world_log WHERE server_id=?").bind(id),
          env.DB.prepare("DELETE FROM player_state WHERE server_id=?").bind(id),
          env.DB.prepare("DELETE FROM block_beams WHERE server_id=?").bind(id),
          env.DB.prepare("DELETE FROM block_state WHERE server_id=?").bind(id),
          env.DB.prepare("DELETE FROM block_inventory WHERE server_id=?").bind(id),
          env.DB.prepare("DELETE FROM world_clock WHERE server_id=?").bind(id),
          env.DB.prepare("DELETE FROM servers WHERE id=?").bind(id)
        ]);
        return json({ ok: true }, 200, origin);
      }

      // ---- Shared world --------------------------------------------------------
      if (path === "/api/world/live" && request.headers.get("Upgrade") === "websocket") {
        const server = serverOf(request);
        const auth = await authenticate(request, env);
        // Same join gate as the REST world endpoints: a closed world gets the
        // same 403 JSON here, which the browser reports as a failed handshake.
        const denied = await gateServer(request, env, server, auth, origin);
        if (denied) return denied;
        // The forwarded URL still carries `?server=`, which is how the object
        // binds its identity — the upgrade request has no body.
        const stub = env.WORLD_LIVE.get(env.WORLD_LIVE.idFromName(server));
        // Hand the object the account the session cookie belongs to, so
        // presence identity is the login and not a client frame. Any value the
        // browser sent is dropped first - only this Worker stamps it.
        const headers = new Headers(request.headers);
        headers.delete(WS_IDENTITY);
        if (auth) headers.set(WS_IDENTITY, auth.user.username);
        return stub.fetch(new Request(request, { headers }));
      }

      if (path === "/api/world" && request.method === "GET") {
        const server = serverOf(request);
        // A stranger must not even read the shape of someone's world.
        const auth = server === GLOBAL_SERVER ? null : await authenticate(request, env);
        const denied = await gateServer(request, env, server, auth, origin);
        if (denied) return denied;
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
        // active-world edit count. Every row is scoped: `global` is the whole
        // legacy world, a server only ever sees its own.
        const [edits, log, head, beams] = await Promise.all([
          env.DB.prepare("SELECT x,y,z,block_id FROM world_edits WHERE server_id=? AND x BETWEEN ? AND ? AND y BETWEEN ? AND ? AND z BETWEEN ? AND ? LIMIT 20000")
            .bind(server, x0, x1, y0, y1, z0, z1).all<EditRow>(),
          // Newest first, then back in order: a client whose cursor fell behind
          // the retained window is corrected by the `edits` snapshot anyway.
          // A log row only means anything while its cell — in the SAME world —
          // still reads that same block in `world_edits`; anything else is a
          // leftover from a deleted block and would repaint a cell the
          // database says is empty.
          env.DB.prepare(`SELECT seq,x,y,z,block_id FROM (
              SELECT seq,x,y,z,block_id FROM world_log l WHERE l.server_id=? AND seq > ? AND EXISTS (
                SELECT 1 FROM world_edits e WHERE e.server_id=l.server_id AND e.x=l.x AND e.y=l.y AND e.z=l.z AND e.block_id=l.block_id
              ) ORDER BY seq DESC LIMIT ${WORLD_LOG_KEEP}
            ) ORDER BY seq ASC`)
            .bind(server, since).all<LogRow>(),
          env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM world_log WHERE server_id=?").bind(server).first<{ head: number }>(),
          listBeams(env, server)
        ]);
        return json({ edits: edits.results, log: log.results, head: head?.head ?? 0, beams }, 200, origin);
      }

      if (path === "/api/world/place" && request.method === "POST") return handlePlace(request, env, origin);
      if (path === "/api/world/break" && request.method === "POST") return handleBreak(request, env, origin);
      if (path === "/api/world/resync" && request.method === "POST") return handleWorldResync(request, env, origin);
      if (path === "/api/block/interact" && request.method === "POST") return handleBlockInteract(request, env, origin);
      if (path === "/api/player/state" && request.method === "GET") return handleGetPlayerState(request, env, origin);
      if (path === "/api/player/state" && request.method === "POST") return handlePutPlayerState(request, env, origin);
      if (path === "/api/player/respawn" && request.method === "POST") return handleRespawn(request, env, origin);
      if (path === "/api/player/eat" && request.method === "POST") return handleEat(request, env, origin);
      if (path === "/api/player/appearance" && request.method === "POST") return handlePostPlayerAppearance(request, env, origin);

      // The world's clock: readable by anyone in the world, dialled by the admin.
      if (path === "/api/time" && request.method === "GET") return handleGetTime(request, env, origin);
      if (path === "/api/time" && request.method === "POST") return handleSetTime(request, env, origin);

      // ---- Inventory ------------------------------------------------------------
      if (path === "/api/inventory" && request.method === "GET") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        // Arranged stacks first, in the order the player dragged them into;
        // everything else falls back to ID order (the pre-drag behaviour).
        const { results } = await env.DB
          .prepare("SELECT item_id, quantity FROM inventories WHERE user_id=? AND quantity>0 ORDER BY (ord IS NULL), ord, item_id")
          .bind(auth.user.id).all<{ item_id: string; quantity: number }>();
        return json({ inventory: results }, 200, origin);
      }

      // Drag-to-arrange: the client posts the whole arrangement of its own
      // stacks. The hotbar is simply the front of that list, so one order
      // moves both. Anything omitted (a stack gained after the drag) goes back
      // to unordered and lands at the end by ID.
      if (path === "/api/inventory/order" && request.method === "POST") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        const data = await body<{ ids: unknown }>(request);
        if (!Array.isArray(data.ids) || data.ids.length > 200) return err("Send up to 200 item IDs.", 400, origin);
        const ids: string[] = [];
        for (const raw of data.ids) {
          const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
          if (!validItemId(id)) return err("One of those item IDs is not valid.", 400, origin);
          ids.push(id);
        }
        const owned = await env.DB
          .prepare("SELECT item_id FROM inventories WHERE user_id=? AND quantity>0")
          .bind(auth.user.id).all<{ item_id: string }>();
        const have = new Set(owned.results.map((r) => r.item_id));
        const cases: string[] = [];
        const binds: (string | number | null)[] = [];
        const placed = new Set<string>();
        for (const [i, id] of ids.entries()) {
          if (!have.has(id) || placed.has(id)) continue;
          placed.add(id);
          cases.push("WHEN ? THEN ?");
          binds.push(id, i + 1);
        }
        for (const id of have) {
          if (placed.has(id)) continue;
          cases.push("WHEN ? THEN ?");
          binds.push(id, null);
        }
        await env.DB
          .prepare(`UPDATE inventories SET ord = CASE item_id ${cases.join(" ")} ELSE NULL END WHERE user_id=?`)
          .bind(...binds, auth.user.id).run();
        return json({ ok: true }, 200, origin);
      }

      if ((path === "/api/inventory/add" || path === "/api/inventory/remove") && request.method === "POST") {
        const auth = await authenticate(request, env);
        if (!auth) return err("Log in first.", 401, origin);
        // Inventory surgery is an admin tool: players earn and spend items
        // through the world (mining, mobs, crafting), never by editing numbers.
        // The client hides these controls; this is the authority behind that.
        if (!isAdminUser(auth.user.username)) return err("Only the admin account can change inventory counts.", 403, origin);
        const data = await body<{ item_id: unknown; quantity: unknown }>(request);
        const itemId = typeof data.item_id === "string" ? data.item_id.trim().toLowerCase() : "";
        const quantity = Number(data.quantity);
        if (!validItemId(itemId)) return err("Use 1–48 letters, numbers, underscores, colons or hyphens for the item ID.", 400, origin);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return err("Quantity must be between 1 and 999.", 400, origin);
        if (path === "/api/inventory/add") {
          const known = await env.DB.prepare("SELECT id FROM items WHERE id=?").bind(itemId).first();
          if (!known) return err("Unknown item ID.", 400, origin);
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
        if (!isAdminUser(auth.user.username)) return err("Only the admin account can clear an inventory.", 403, origin);
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
