// One-command offline private servers: the real backend + a static frontend
// on this machine, nothing phoning home. Wrangler dev runs the worker against
// a persistent local D1/DO state dir (--persist), so worlds, inventories, and
// player state survive restarts. The static server just serves frontend/.
//
//   npm run offline          -> http://127.0.0.1:8080
//
// Requires Node 22+ and `npm ci` in backend/ once; no internet at run time
// (fonts from Google degrade silently, the app.js script tag goes same-origin
// on a localhost page). LAN serving is out of scope: the session cookie is
// `__Host-ac_session` (Secure) and backend CORS only accepts localhost — the
// browser has to run on this machine.
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const FRONTEND = join(ROOT, "frontend");
const BACKEND = join(ROOT, "backend");
const STATIC_PORT = Number(process.env.AC_STATIC_PORT || 8080);
const API_PORT = Number(process.env.AC_API_PORT || 8787);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".ico": "image/x-icon", ".wasm": "application/wasm",
  ".woff2": "font/woff2", ".map": "application/json", ".db": "application/octet-stream",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let p = normalize(decodeURIComponent(url.pathname));
  if (p === "/" || p === "\\") p = "/index.html";
  const file = join(FRONTEND, p);
  if (!file.startsWith(FRONTEND)) { res.writeHead(403).end("no"); return; }
  if (extname(file) === "") { res.writeHead(404).end("not found"); return; }
  import("node:fs").then(({ createReadStream, existsSync, statSync }) => {
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
  });
});

// The offline stack runs the real worker: wrangler dev on this machine, bound
// to loopback. The page (served from the same origin on :8080) talks to
// http://localhost:8787, so the API port is what the client-side local switch
// (settings.server === "local") already expects. Override both for the proof
// harness via AC_STATIC_PORT / AC_API_PORT / AC_STATE_DIR.
const persist = process.env.AC_STATE_DIR
  ? ["--persist-to", resolve(process.env.AC_STATE_DIR)]
  : ["--persist"];

// The local dependency's binary — not `npx wrangler`: npx does not forward
// signals, so a SIGTERM here would orphan the real wrangler holding the port.
const WR = join(BACKEND, "node_modules", ".bin", "wrangler");

// A fresh state dir has no tables at all, so the first `npm run offline` on
// a machine would boot a healthy-looking API that 500s on every query.
// Apply the migrations before serving: idempotent, local-only, and the whole
// point of offline mode is that it needs no one else's deploy step.
const mig = spawnSync(WR, ["d1", "migrations", "apply", "all-contribute-db", "--local", ...persist], {
  cwd: BACKEND, stdio: "inherit", env: process.env, timeout: 300000,
});
if (mig.status !== 0) {
  console.error("local migrations failed - is Node 22 active and `npm ci` done in backend/?");
  process.exit(mig.status ?? 1);
}

const wrangler = spawn(WR, ["dev", "--port", String(API_PORT), ...persist], {
  cwd: BACKEND, stdio: "inherit", env: process.env,
});

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  wrangler.kill("SIGTERM");
  server.close();
  process.exit(code);
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
wrangler.on("exit", (code) => { console.error("backend exited:", code); shutdown(code ?? 1); });

server.listen(STATIC_PORT, "127.0.0.1", () => {
  console.log("all-contribute offline mode");
  console.log(`  api:    http://127.0.0.1:${API_PORT}`);
  console.log(`  open    http://127.0.0.1:${STATIC_PORT}`);
  console.log(`worlds persist in ${process.env.AC_STATE_DIR || resolve(BACKEND, ".wrangler/state")} across restarts`);
});
