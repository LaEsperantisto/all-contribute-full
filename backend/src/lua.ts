// Sandboxed Lua-subset interpreter for attacker-authored block scripts.
// Self-contained: no imports, no eval, no host objects reachable from script
// values. Lexer -> recursive-descent parser -> tree-walking evaluator over its
// own value model. Every failure mode returns a ScriptOutcome; runBlockScript
// never throws.

export interface ScriptState {
  get(key: string): string | number | null;
  set(key: string, value: string | number | null): void; // null deletes
}

export interface ScriptOutcome {
  ok: boolean;
  error?: string;
  menu?: { title: string; options: { key: string; label: string }[] };
  beams: { colour: string }[];
  toasts: string[];
  logs: string[];
  // Effects on the host world. The interpreter never touches the database, so
  // a move, an item handout or a cell-store write is RECORDED here and applied
  // by the caller in its own flush — the same pattern as state_set writes.
  // `stored` is the cell's final inventory; qty 0 means the row goes away.
  moves: { kind: "position" | "respawn"; x: number; y: number; z: number }[];
  gives: { item: string; qty: number }[];
  takes: { item: string; qty: number }[];
  stored: { item: string; qty: number }[];
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_STRING = 4096;
const MAX_TABLE = 256;
const MAX_DEPTH = 32;
const MAX_STATE_VALUE = 128;
const MAX_STATE_KEY = 128;
const MAX_MENU_KEY = 32;
const MAX_MENU_OPTIONS = 12;
const MAX_BEAM_COLOUR = 32;
const MAX_OUTPUT_ITEMS = 64; // beams / toasts / logs per run
const MAX_INV_ITEMS = 32;    // distinct item ids one cell can hold
const MAX_STACK = 999;       // mirrors the inventory quantity bound
const MAX_MOVES = 8;         // position/anchor writes per run
// Item ids are registry ids: `builtin:apple`, `player:user:ns:item`.
const ITEM_ID = /^[a-z0-9_]{1,32}(:[a-z0-9_]{1,32}){1,3}$/;
const MAX_CALL_DEPTH = 128;
const DEFAULT_MAX_INSTRUCTIONS = 20000;
const DEFAULT_WALL_MS = 50;

// ---------------------------------------------------------------------------
// Value model: nil(null) | boolean | number | string | table | function
// ---------------------------------------------------------------------------

type LuaValue = null | boolean | number | string | LTable | LuaFunc;
type LuaFunc = (args: LuaValue[]) => LuaValue[];

class LTable {
  arr: LuaValue[] = []; // positional part; holes are null
  map = new Map<unknown, LuaValue>(); // non-integer keys; values are never null
  entries = 0; // live (non-nil) entry count, both parts
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
}

const LUA_MARK = "__luaUserFunction";

function typeName(v: LuaValue): string {
  if (v === null) return "nil";
  if (typeof v === "function") return "function";
  if (v instanceof LTable) return "table";
  return typeof v; // "boolean" | "number" | "string"
}

class LuaError extends Error {}
class BreakSignal {}
class ContinueSignal {}
class ReturnSignal {
  readonly vals: LuaValue[];
  constructor(vals: LuaValue[]) {
    this.vals = vals;
  }
}

interface Ctx {
  steps: number;
  maxSteps: number;
  start: number;
  wallMs: number;
  calls: number;
}

function tick(ctx: Ctx): void {
  ctx.steps++;
  if (ctx.steps > ctx.maxSteps) {
    throw new LuaError(`instruction budget exceeded (${ctx.maxSteps})`);
  }
  if ((ctx.steps & 511) === 0 && Date.now() - ctx.start > ctx.wallMs) {
    throw new LuaError(`wall-clock budget exceeded (${ctx.wallMs}ms)`);
  }
}

// ---------------------------------------------------------------------------
// Number / string helpers
// ---------------------------------------------------------------------------

// Lua-style integer formatting: 2 not 2.0. Floats fall back to JS formatting.
function fmtNum(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return Object.is(n, -0) ? "-0" : String(n);
  return String(n);
}

function checkStrLen(s: string): string {
  if (s.length > MAX_STRING) throw new LuaError(`string too long (limit ${MAX_STRING})`);
  return s;
}

// Strict Lua-style numeric string parse; null when not a number.
function parseNumStrict(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function toNum(v: LuaValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseNumStrict(v);
    if (n !== null) return n;
  }
  throw new LuaError(`attempt to perform arithmetic on a ${typeName(v)} value`);
}

// String in string contexts: strings pass, numbers format Lua-style.
function checkStr(v: LuaValue): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return fmtNum(v);
  throw new LuaError(`expecting a string, got ${typeName(v)}`);
}

// tostring()-style coercion (accepts anything).
function toStrAny(v: LuaValue): string {
  if (v === null) return "nil";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return fmtNum(v);
  if (typeof v === "string") return v;
  if (typeof v === "function") return "function: builtin";
  return `table: 0x${v.id.toString(16)}`;
}

// Concatenation operand: nil/bool/table/function are errors.
function concatStr(v: LuaValue): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return fmtNum(v);
  throw new LuaError(`attempt to concatenate a ${typeName(v)} value`);
}

// ---------------------------------------------------------------------------
// Table operations
// ---------------------------------------------------------------------------

function normKey(k: LuaValue): unknown {
  if (typeof k === "number") {
    if (Number.isNaN(k)) throw new LuaError("table index is NaN");
    return Object.is(k, -0) ? 0 : k;
  }
  return k; // string | boolean | table | function (identity keys)
}

function arrayIndex(k: unknown): number | null {
  if (typeof k === "number" && Number.isInteger(k) && k >= 1 && k <= 1024) return k;
  return null;
}

function tget(t: LTable, k: LuaValue): LuaValue {
  if (k === null) return null; // reading t[nil] is legal in Lua
  const kk = typeof k === "number" && Object.is(k, -0) ? 0 : k;
  const ai = arrayIndex(kk);
  if (ai !== null) return t.arr[ai - 1] ?? null;
  return t.map.get(kk) ?? null;
}

function tset(t: LTable, k: LuaValue, v: LuaValue): void {
  if (k === null) throw new LuaError("table index is nil");
  const kk = normKey(k);
  const ai = arrayIndex(kk);
  if (ai !== null) {
    const old = t.arr[ai - 1] ?? null;
    if (old === null) {
      if (v !== null) {
        if (t.entries + 1 > MAX_TABLE) throw new LuaError(`table size limit exceeded (${MAX_TABLE})`);
        t.entries++;
      }
    } else if (v === null) {
      t.entries--;
    }
    t.arr[ai - 1] = v;
    return;
  }
  const had = t.map.has(kk);
  if (!had) {
    if (v !== null) {
      if (t.entries + 1 > MAX_TABLE) throw new LuaError(`table size limit exceeded (${MAX_TABLE})`);
      t.entries++;
      t.map.set(kk, v);
    }
  } else if (v === null) {
    t.entries--;
    t.map.delete(kk);
  } else {
    t.map.set(kk, v);
  }
}

// '#' border: first nil position minus one, scanning the positional part.
function tlen(t: LTable): number {
  let len = 0;
  while (len < t.arr.length && (t.arr[len] ?? null) !== null) len++;
  return len;
}

function allPairs(t: LTable): { k: LuaValue; v: LuaValue }[] {
  const out: { k: LuaValue; v: LuaValue }[] = [];
  for (let i = 0; i < t.arr.length; i++) {
    const v = t.arr[i] ?? null;
    if (v !== null) out.push({ k: i + 1, v });
  }
  for (const [k, v] of t.map) out.push({ k: k as LuaValue, v });
  return out;
}

// next-style traversal used by pairs().
function nextKey(t: LTable, prev: LuaValue): LuaValue | null {
  if (prev === null) {
    for (let i = 0; i < t.arr.length; i++) {
      if ((t.arr[i] ?? null) !== null) return i + 1;
    }
    const first = t.map.keys().next();
    return first.done ? null : (first.value as LuaValue);
  }
  if (typeof prev === "number") {
    for (let i = prev; i < t.arr.length; i++) {
      if ((t.arr[i] ?? null) !== null) return i + 1;
    }
    // positional part exhausted (prev might exceed arr.length too)
    for (const [k] of t.map) {
      if (k === prev) {
        const it = t.map.keys();
        let r = it.next();
        while (!r.done) {
          if (r.value !== prev) return r.value as LuaValue;
          r = it.next();
        }
        return null;
      }
    }
    return null;
  }
  const it = t.map.keys();
  let r = it.next();
  while (!r.done) {
    if (r.value === prev) {
      const n = it.next();
      return n.done ? null : (n.value as LuaValue);
    }
    r = it.next();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokKind = "id" | "num" | "str" | "kw" | "op" | "eof";

interface Tok {
  kind: TokKind;
  text: string; // decoded value for str, raw for others
  num?: number;
  pos: number;
}

const KEYWORDS = new Set([
  "and", "break", "continue", "do", "else", "elseif", "end", "false", "for",
  "function", "if", "in", "local", "nil", "not", "or", "return", "then",
  "true", "while",
]);

const TWO_CHAR_OPS = ["..", "==", "~=", "<=", ">=", "//"];
const ONE_CHAR_OPS = "+-*/%^#<>=()[]{}.,;:";

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  const isIdChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c: string): boolean => c >= "0" && c <= "9";
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\v" || c === "\f") {
      i++;
      continue;
    }
    if (c === "-" && src[i + 1] === "-") {
      if (src[i + 2] === "[" && src[i + 3] === "[") {
        const close = src.indexOf("]]", i + 4);
        if (close < 0) throw new LuaError("unfinished long comment");
        i = close + 2;
        continue;
      }
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && isIdChar(src[j])) j++;
      const w = src.slice(i, j);
      toks.push({ kind: KEYWORDS.has(w) ? "kw" : "id", text: w, pos: i });
      i = j;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && isDigit(src[j])) j++;
      if (src[j] === ".") {
        j++;
        while (j < n && isDigit(src[j])) j++;
      }
      if (src[j] === "e" || src[j] === "E") {
        let k = j + 1;
        if (src[k] === "+" || src[k] === "-") k++;
        if (isDigit(src[k] ?? "")) {
          j = k + 1;
          while (j < n && isDigit(src[j])) j++;
        }
      }
      toks.push({ kind: "num", text: src.slice(i, j), num: Number(src.slice(i, j)), pos: i });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      let out = "";
      while (i < n && src[i] !== q) {
        let ch = src[i];
        if (ch === "\\") {
          i++;
          const e = src[i];
          if (e === undefined) break;
          if (e === "n") out += "\n";
          else if (e === "t") out += "\t";
          else if (e === "r") out += "\r";
          else if (e === "a") out += "\x07";
          else if (e === "b") out += "\b";
          else if (e === "f") out += "\f";
          else if (e === "v") out += "\v";
          else if (e === "\\") out += "\\";
          else if (e === '"' || e === "'" || e === "\n") out += e;
          else if (e === "x") {
            const hex = src.slice(i + 1, i + 3);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new LuaError("invalid escape '\\x'");
            out += String.fromCharCode(parseInt(hex, 16));
            i += 2;
          } else if (isDigit(e)) {
            let digits = e;
            while (digits.length < 3 && isDigit(src[i + 1] ?? "")) {
              digits += src[i + 1];
              i++;
            }
            out += String.fromCharCode(parseInt(digits, 10) & 0xff);
          } else {
            throw new LuaError(`invalid escape '\\${e}'`);
          }
          i++;
          ch = ""; // consumed
          continue;
        }
        out += ch;
        i++;
      }
      if (i >= n) throw new LuaError("unfinished string");
      i++; // closing quote
      toks.push({ kind: "str", text: checkStrLen(out), pos: i });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      toks.push({ kind: "op", text: two, pos: i });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.includes(c)) {
      toks.push({ kind: "op", text: c, pos: i });
      i++;
      continue;
    }
    throw new LuaError(`unexpected character '${c === "\n" ? "\\n" : c}' (near byte ${i})`);
  }
  toks.push({ kind: "eof", text: "<eof>", pos: n });
  return toks;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type TItem =
  | { kind: "pos"; e: Expr }
  | { kind: "kv"; k: Expr; v: Expr };

type Stmt =
  | { t: "local"; names: string[]; init: Expr[] }
  | { t: "assign"; targets: Expr[]; values: Expr[] }
  | { t: "do"; body: Stmt[] }
  | { t: "while"; cond: Expr; body: Stmt[] }
  | { t: "if"; arms: { cond: Expr; body: Stmt[] }[]; elseBody: Stmt[] | null }
  | { t: "fornum"; name: string; start: Expr; limit: Expr; step: Expr | null; body: Stmt[] }
  | { t: "forin"; names: string[]; iter: Expr[]; body: Stmt[] }
  | { t: "func"; name: string; params: string[]; body: Stmt[] }
  | { t: "localfunc"; name: string; params: string[]; body: Stmt[] }
  | { t: "return"; values: Expr[] }
  | { t: "callstmt"; e: Expr }
  | { t: "break" }
  | { t: "continue" };

type Expr =
  | { t: "nil" }
  | { t: "bool"; v: boolean }
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "name"; v: string }
  | { t: "getfield"; obj: Expr; k: string }
  | { t: "getindex"; obj: Expr; idx: Expr }
  | { t: "call"; fn: Expr; args: Expr[] }
  | { t: "table"; items: TItem[] }
  | { t: "unop"; op: "-" | "#" | "not"; e: Expr }
  | { t: "binop"; op: string; l: Expr; r: Expr };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private i = 0;
  private depth = 0;
  private readonly toks: Tok[];

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok {
    return this.toks[this.i];
  }

  private at(kind: TokKind, text?: string): boolean {
    const t = this.peek();
    return t.kind === kind && (text === undefined || t.text === text);
  }

  private take(): Tok {
    const t = this.peek();
    if (t.kind === "eof") this.error("unexpected end of chunk");
    this.i++;
    return t;
  }

  private error(msg: string): never {
    throw new LuaError(`syntax error: ${msg} (near byte ${this.peek().pos})`);
  }

  private expectOp(text: string): void {
    if (!this.at("op", text)) this.error(`'${text}' expected`);
    this.i++;
  }

  private expectKw(text: string): void {
    if (!this.at("kw", text)) this.error(`'${text}' expected`);
    this.i++;
  }

  private name(): string {
    if (!this.at("id")) this.error(`identifier expected near '${this.peek().text}'`);
    return this.take().text;
  }

  private down(): void {
    if (++this.depth > MAX_DEPTH) {
      this.depth--;
      throw new LuaError(`too much nesting (limit ${MAX_DEPTH})`);
    }
  }

  private up(): void {
    this.depth--;
  }

  parseChunk(): Stmt[] {
    const body = this.block();
    if (!this.at("eof")) this.error(`unexpected '${this.peek().text}'`);
    return body;
  }

  private block(): Stmt[] {
    this.down();
    const out: Stmt[] = [];
    for (;;) {
      if (this.at("op", ";")) {
        this.i++;
        continue;
      }
      if (this.at("kw", "end") || this.at("kw", "else") || this.at("kw", "elseif") || this.at("eof")) break;
      out.push(this.stmt());
    }
    this.up();
    return out;
  }

  private stmt(): Stmt {
    const t = this.peek();
    if (t.kind === "kw") {
      switch (t.text) {
        case "local":
          return this.localStmt();
        case "if":
          return this.ifStmt();
        case "while":
          return this.whileStmt();
        case "for":
          return this.forStmt();
        case "do": {
          this.i++;
          const body = this.block();
          this.expectKw("end");
          return { t: "do", body };
        }
        case "return": {
          this.i++;
          let values: Expr[] = [];
          if (!this.at("op", ";") && !this.at("kw", "end") && !this.at("kw", "else") &&
              !this.at("kw", "elseif") && !this.at("eof")) {
            values = this.explist();
          }
          return { t: "return", values };
        }
        case "function": {
          this.i++;
          const name = this.name();
          const { params, body } = this.funcBody();
          return { t: "func", name, params, body };
        }
        case "break":
          this.i++;
          return { t: "break" };
        case "continue":
          this.i++;
          return { t: "continue" };
      }
    }
    const e = this.suffixedExp();
    if (this.at("op", "=") || this.at("op", ",")) {
      const targets = [e];
      while (this.at("op", ",")) {
        this.i++;
        targets.push(this.suffixedExp());
      }
      this.expectOp("=");
      const values = this.explist();
      for (const tgt of targets) {
        if (tgt.t !== "name" && tgt.t !== "getfield" && tgt.t !== "getindex") {
          this.error("malformed assignment");
        }
      }
      return { t: "assign", targets, values };
    }
    if (e.t !== "call") this.error(`syntax error near '${t.kind === "str" ? "string" : t.text}'`);
    return { t: "callstmt", e };
  }

  private localStmt(): Stmt {
    this.expectKw("local");
    if (this.at("kw", "function")) {
      this.i++;
      const name = this.name();
      const { params, body } = this.funcBody();
      return { t: "localfunc", name, params, body };
    }
    const names = [this.name()];
    while (this.at("op", ",")) {
      this.i++;
      names.push(this.name());
    }
    let init: Expr[] = [];
    if (this.at("op", "=")) {
      this.i++;
      init = this.explist();
    }
    return { t: "local", names, init };
  }

  private funcBody(): { params: string[]; body: Stmt[] } {
    this.expectOp("(");
    const params: string[] = [];
    if (!this.at("op", ")")) {
      for (;;) {
        if (this.at("op", ".") || this.at("kw", "not") || this.at("kw", "nil")) {
          this.error("varargs '...' are not supported");
        }
        params.push(this.name());
        if (this.at("op", ",")) {
          this.i++;
          continue;
        }
        break;
      }
    }
    this.expectOp(")");
    const body = this.block();
    this.expectKw("end");
    return { params, body };
  }

  private ifStmt(): Stmt {
    this.expectKw("if");
    const arms: { cond: Expr; body: Stmt[] }[] = [];
    for (;;) {
      const cond = this.expr();
      this.expectKw("then");
      arms.push({ cond, body: this.block() });
      if (this.at("kw", "elseif")) {
        this.i++;
        continue;
      }
      break;
    }
    let elseBody: Stmt[] | null = null;
    if (this.at("kw", "else")) {
      this.i++;
      elseBody = this.block();
    }
    this.expectKw("end");
    return { t: "if", arms, elseBody };
  }

  private whileStmt(): Stmt {
    this.expectKw("while");
    const cond = this.expr();
    this.expectKw("do");
    const body = this.block();
    this.expectKw("end");
    return { t: "while", cond, body };
  }

  private forStmt(): Stmt {
    this.expectKw("for");
    const first = this.name();
    if (this.at("op", "=")) {
      this.i++;
      const start = this.expr();
      this.expectOp(",");
      const limit = this.expr();
      let step: Expr | null = null;
      if (this.at("op", ",")) {
        this.i++;
        step = this.expr();
      }
      this.expectKw("do");
      const body = this.block();
      this.expectKw("end");
      return { t: "fornum", name: first, start, limit, step, body };
    }
    const names = [first];
    while (this.at("op", ",")) {
      this.i++;
      names.push(this.name());
    }
    this.expectKw("in");
    const iter = this.explist();
    this.expectKw("do");
    const body = this.block();
    this.expectKw("end");
    return { t: "forin", names, iter, body };
  }

  private explist(): Expr[] {
    const out = [this.expr()];
    while (this.at("op", ",")) {
      this.i++;
      out.push(this.expr());
    }
    return out;
  }

  private optExplist(): Expr[] {
    if (this.at("op", ")")) return [];
    return this.explist();
  }

  // or < and < comparison < .. < + - < * / // % < unary < ^
  private expr(): Expr {
    this.down();
    const e = this.orExp();
    this.up();
    return e;
  }

  private orExp(): Expr {
    let l = this.andExp();
    while (this.at("kw", "or")) {
      this.i++;
      l = { t: "binop", op: "or", l, r: this.andExp() };
    }
    return l;
  }

  private andExp(): Expr {
    let l = this.compExp();
    while (this.at("kw", "and")) {
      this.i++;
      l = { t: "binop", op: "and", l, r: this.compExp() };
    }
    return l;
  }

  private compExp(): Expr {
    let l = this.concatExp();
    for (;;) {
      const op = this.peek();
      if (op.kind === "op" && ["<", "<=", ">", ">=", "==", "~="].includes(op.text)) {
        this.i++;
        l = { t: "binop", op: op.text, l, r: this.concatExp() };
      } else break;
    }
    return l;
  }

  private concatExp(): Expr {
    const l = this.addExp();
    if (this.at("op", "..")) {
      this.i++;
      this.down();
      const r = this.concatExp();
      this.up();
      return { t: "binop", op: "..", l, r }; // right-assoc
    }
    return l;
  }

  private addExp(): Expr {
    let l = this.mulExp();
    for (;;) {
      const op = this.peek();
      if (op.kind === "op" && (op.text === "+" || op.text === "-")) {
        this.i++;
        l = { t: "binop", op: op.text, l, r: this.mulExp() };
      } else break;
    }
    return l;
  }

  private mulExp(): Expr {
    let l = this.unaryExp();
    for (;;) {
      const op = this.peek();
      if (op.kind === "op" && ["*", "/", "//", "%"].includes(op.text)) {
        this.i++;
        l = { t: "binop", op: op.text, l, r: this.unaryExp() };
      } else break;
    }
    return l;
  }

  private unaryExp(): Expr {
    const op = this.peek();
    if (op.kind === "op" && (op.text === "-" || op.text === "#")) {
      this.i++;
      this.down();
      const e = this.unaryExp();
      this.up();
      return { t: "unop", op: op.text as "-", e };
    }
    if (op.kind === "kw" && op.text === "not") {
      this.i++;
      this.down();
      const e = this.unaryExp();
      this.up();
      return { t: "unop", op: "not", e };
    }
    return this.powExp();
  }

  private powExp(): Expr {
    const base = this.suffixedExp();
    if (this.at("op", "^")) {
      this.i++;
      this.down();
      const r = this.unaryExp(); // right-assoc, allows 2^-2
      this.up();
      return { t: "binop", op: "^", l: base, r };
    }
    return base;
  }

  private suffixedExp(): Expr {
    let e = this.primaryExp();
    for (;;) {
      if (this.at("op", ".")) {
        this.i++;
        e = { t: "getfield", obj: e, k: this.name() };
      } else if (this.at("op", "[")) {
        this.i++;
        const idx = this.expr();
        this.expectOp("]");
        e = { t: "getindex", obj: e, idx };
      } else if (this.at("op", "(")) {
        this.i++;
        const args = this.optExplist();
        this.expectOp(")");
        e = { t: "call", fn: e, args };
      } else if (this.at("str")) {
        e = { t: "call", fn: e, args: [{ t: "str", v: this.take().text }] };
      } else if (this.at("op", "{")) {
        e = { t: "call", fn: e, args: [this.tableCtor()] };
      } else break;
    }
    return e;
  }

  private primaryExp(): Expr {
    const t = this.peek();
    if (t.kind === "num") {
      this.i++;
      return { t: "num", v: t.num as number };
    }
    if (t.kind === "str") {
      this.i++;
      return { t: "str", v: t.text };
    }
    if (t.kind === "id") {
      this.i++;
      return { t: "name", v: t.text };
    }
    if (t.kind === "kw") {
      if (t.text === "nil") {
        this.i++;
        return { t: "nil" };
      }
      if (t.text === "true" || t.text === "false") {
        this.i++;
        return { t: "bool", v: t.text === "true" };
      }
    }
    if (t.kind === "op") {
      if (t.text === "(") {
        this.i++;
        const e = this.expr();
        this.expectOp(")");
        return e;
      }
      if (t.text === "{") return this.tableCtor();
    }
    this.error(`unexpected symbol '${t.text}'`);
  }

  private tableCtor(): Expr {
    this.down();
    this.expectOp("{");
    const items: TItem[] = [];
    while (!this.at("op", "}")) {
      if (this.at("op", "[")) {
        this.i++;
        const k = this.expr();
        this.expectOp("]");
        this.expectOp("=");
        items.push({ kind: "kv", k, v: this.expr() });
      } else {
        const e = this.expr();
        if (this.at("op", "=") && e.t === "name") {
          this.i++;
          items.push({ kind: "kv", k: { t: "str", v: e.v }, v: this.expr() });
        } else {
          items.push({ kind: "pos", e });
        }
      }
      if (this.at("op", ",")) {
        this.i++;
        continue;
      }
      break;
    }
    this.expectOp("}");
    this.up();
    return { t: "table", items };
  }
}

// ---------------------------------------------------------------------------
// Scopes and evaluator
// ---------------------------------------------------------------------------

interface Scope {
  vars: Map<string, LuaValue>;
  parent: Scope | null;
}

function findScope(env: Scope, name: string): Scope | null {
  let s: Scope | null = env;
  while (s !== null) {
    if (s.vars.has(name)) return s;
    s = s.parent;
  }
  return null;
}

function rootScope(env: Scope): Scope {
  let s = env;
  while (s.parent !== null) s = s.parent;
  return s;
}

function getVar(env: Scope, name: string): LuaValue {
  const s = findScope(env, name);
  return s === null ? null : (s.vars.get(name) ?? null);
}

function setVar(env: Scope, name: string, v: LuaValue): void {
  const s = findScope(env, name) ?? rootScope(env);
  s.vars.set(name, v);
}

function truthy(v: LuaValue): boolean {
  return v !== null && v !== false;
}

function makeLuaFn(params: string[], body: Stmt[], env: Scope, ctx: Ctx): LuaFunc {
  const f: LuaFunc = (args) => {
    const inner: Scope = { vars: new Map(), parent: env };
    for (let i = 0; i < params.length; i++) inner.vars.set(params[i], args[i] ?? null);
    try {
      execBlock(body, inner, ctx);
    } catch (r) {
      if (r instanceof ReturnSignal) return r.vals;
      throw r;
    }
    return [];
  };
  (f as unknown as Record<string, boolean>)[LUA_MARK] = true;
  return f;
}

function callValue(f: LuaValue, args: LuaValue[], ctx: Ctx): LuaValue[] {
  if (typeof f !== "function") {
    throw new LuaError(`attempt to call a ${typeName(f)} value`);
  }
  if ((f as unknown as Record<string, boolean>)[LUA_MARK] === true) {
    ctx.calls++;
    if (ctx.calls > MAX_CALL_DEPTH) {
      ctx.calls--;
      throw new LuaError(`call budget exceeded (depth ${MAX_CALL_DEPTH})`);
    }
    try {
      return f(args);
    } finally {
      ctx.calls--;
    }
  }
  return f(args);
}

function evalExplist(list: Expr[], env: Scope, ctx: Ctx): LuaValue[] {
  const out: LuaValue[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.t === "call" && i === list.length - 1) {
      out.push(...evalCallFull(e, env, ctx));
    } else {
      out.push(eval1(e, env, ctx));
    }
  }
  return out;
}

function evalArgs(list: Expr[], env: Scope, ctx: Ctx): LuaValue[] {
  return evalExplist(list, env, ctx);
}

function execBlock(body: Stmt[], env: Scope, ctx: Ctx): void {
  for (const s of body) exec(s, env, ctx);
}

function runLoopBody(body: Stmt[], iterScope: Scope, ctx: Ctx): boolean {
  // returns true to break
  try {
    execBlock(body, iterScope, ctx);
  } catch (r) {
    if (r instanceof BreakSignal) return true;
    if (r instanceof ContinueSignal) return false;
    throw r;
  }
  return false;
}

function exec(s: Stmt, env: Scope, ctx: Ctx): void {
  tick(ctx);
  switch (s.t) {
    case "local": {
      const vals = evalExplist(s.init, env, ctx);
      for (let i = 0; i < s.names.length; i++) env.vars.set(s.names[i], vals[i] ?? null);
      return;
    }
    case "assign": {
      const vals = evalExplist(s.values, env, ctx);
      for (let i = 0; i < s.targets.length; i++) {
        const tgt = s.targets[i];
        const v = vals[i] ?? null;
        if (tgt.t === "name") {
          setVar(env, tgt.v, v);
        } else if (tgt.t === "getfield") {
          const obj = eval1(tgt.obj, env, ctx);
          if (!(obj instanceof LTable)) throw new LuaError(`attempt to index a ${typeName(obj)} value`);
          tset(obj, tgt.k, v);
        } else if (tgt.t === "getindex") {
          const obj = eval1(tgt.obj, env, ctx);
          if (!(obj instanceof LTable)) throw new LuaError(`attempt to index a ${typeName(obj)} value`);
          const k = eval1(tgt.idx, env, ctx);
          tset(obj, k, v);
        } else {
          throw new LuaError("malformed assignment");
        }
      }
      return;
    }
    case "do":
      execBlock(s.body, { vars: new Map(), parent: env }, ctx);
      return;
    case "while": {
      for (;;) {
        if (!truthy(eval1(s.cond, env, ctx))) break;
        if (runLoopBody(s.body, { vars: new Map(), parent: env }, ctx)) break;
      }
      return;
    }
    case "if": {
      for (const arm of s.arms) {
        if (truthy(eval1(arm.cond, env, ctx))) {
          execBlock(arm.body, { vars: new Map(), parent: env }, ctx);
          return;
        }
      }
      if (s.elseBody !== null) execBlock(s.elseBody, { vars: new Map(), parent: env }, ctx);
      return;
    }
    case "fornum": {
      const a = toNum(eval1(s.start, env, ctx));
      const b = toNum(eval1(s.limit, env, ctx));
      const step = s.step === null ? 1 : toNum(eval1(s.step, env, ctx));
      if (step === 0) throw new LuaError("'for' step is zero");
      if (step > 0) {
        for (let i = a; i <= b; i += step) {
          const iterScope: Scope = { vars: new Map([[s.name, i]]), parent: env };
          if (runLoopBody(s.body, iterScope, ctx)) break;
        }
      } else {
        for (let i = a; i >= b; i += step) {
          const iterScope: Scope = { vars: new Map([[s.name, i]]), parent: env };
          if (runLoopBody(s.body, iterScope, ctx)) break;
        }
      }
      return;
    }
    case "forin": {
      const state = evalExplist(s.iter, env, ctx);
      const iterFn = state[0] ?? null;
      const control = state[1] ?? null;
      let var1 = state[2] ?? null;
      if (iterFn === null || typeof iterFn !== "function") {
        throw new LuaError(`attempt to iterate a ${typeName(iterFn)} value`);
      }
      for (;;) {
        const vals = callValue(iterFn, [control, var1], ctx);
        const first = vals[0] ?? null;
        if (first === null) break;
        var1 = first;
        const iterScope: Scope = { vars: new Map(), parent: env };
        for (let i = 0; i < s.names.length; i++) iterScope.vars.set(s.names[i], vals[i] ?? null);
        if (runLoopBody(s.body, iterScope, ctx)) break;
      }
      return;
    }
    case "func":
      setVar(env, s.name, makeLuaFn(s.params, s.body, env, ctx));
      return;
    case "localfunc": {
      env.vars.set(s.name, null); // visible inside body for recursion
      env.vars.set(s.name, makeLuaFn(s.params, s.body, env, ctx));
      return;
    }
    case "return":
      throw new ReturnSignal(evalExplist(s.values, env, ctx));
    case "callstmt":
      eval1(s.e, env, ctx);
      return;
    case "break":
      throw new BreakSignal();
    case "continue":
      throw new ContinueSignal();
  }
}

function luaEq(l: LuaValue, r: LuaValue): boolean {
  if (l === r) return true;
  if (typeof l === "number" && typeof r === "number") return l === r;
  if (typeof l === "string" && typeof r === "string") return l === r;
  return false;
}

function luaCompare(op: string, l: LuaValue, r: LuaValue): boolean {
  if (typeof l === "number" && typeof r === "number") {
    switch (op) {
      case "<": return l < r;
      case "<=": return l <= r;
      case ">": return l > r;
      default: return l >= r;
    }
  }
  if (typeof l === "string" && typeof r === "string") {
    switch (op) {
      case "<": return l < r;
      case "<=": return l <= r;
      case ">": return l > r;
      default: return l >= r;
    }
  }
  throw new LuaError(`attempt to compare ${typeName(l)} with ${typeName(r)}`);
}

function eval1(e: Expr, env: Scope, ctx: Ctx): LuaValue {
  tick(ctx);
  switch (e.t) {
    case "nil":
      return null;
    case "bool":
      return e.v;
    case "num":
      return e.v;
    case "str":
      return e.v;
    case "name":
      return getVar(env, e.v);
    case "getfield": {
      const obj = eval1(e.obj, env, ctx);
      if (!(obj instanceof LTable)) throw new LuaError(`attempt to index a ${typeName(obj)} value`);
      return tget(obj, e.k);
    }
    case "getindex": {
      const obj = eval1(e.obj, env, ctx);
      if (!(obj instanceof LTable)) throw new LuaError(`attempt to index a ${typeName(obj)} value`);
      return tget(obj, eval1(e.idx, env, ctx));
    }
    case "call": {
      const v = evalCallFull(e, env, ctx);
      return v[0] ?? null;
    }
    case "table": {
      const tbl = new LTable(nextTableId());
      for (let idx = 0; idx < e.items.length; idx++) {
        const item = e.items[idx];
        if (item.kind === "kv") {
          const k = eval1(item.k, env, ctx);
          const v = eval1(item.v, env, ctx);
          tset(tbl, k, v);
        } else if (item.e.t === "call" && idx === e.items.length - 1) {
          for (const v of evalCallFull(item.e, env, ctx)) tset(tbl, tbl.arr.length + 1, v);
        } else {
          tset(tbl, tbl.arr.length + 1, eval1(item.e, env, ctx));
        }
      }
      return tbl;
    }
    case "unop": {
      if (e.op === "not") return !truthy(eval1(e.e, env, ctx));
      const v = eval1(e.e, env, ctx);
      if (e.op === "-") {
        const n = toNum(v);
        return n === 0 ? -0 : -n;
      }
      // '#'
      if (typeof v === "string") return v.length;
      if (v instanceof LTable) return tlen(v);
      throw new LuaError(`attempt to get length of a ${typeName(v)} value`);
    }
    case "binop": {
      const op = e.op;
      if (op === "and") {
        const l = eval1(e.l, env, ctx);
        return truthy(l) ? eval1(e.r, env, ctx) : l;
      }
      if (op === "or") {
        const l = eval1(e.l, env, ctx);
        return truthy(l) ? l : eval1(e.r, env, ctx);
      }
      if (op === "==") return luaEq(eval1(e.l, env, ctx), eval1(e.r, env, ctx));
      if (op === "~=") return !luaEq(eval1(e.l, env, ctx), eval1(e.r, env, ctx));
      if (op === "<" || op === "<=" || op === ">" || op === ">=") {
        return luaCompare(op, eval1(e.l, env, ctx), eval1(e.r, env, ctx));
      }
      if (op === "..") {
        const l = concatStr(eval1(e.l, env, ctx));
        const r = concatStr(eval1(e.r, env, ctx));
        return checkStrLen(l + r);
      }
      const l = toNum(eval1(e.l, env, ctx));
      const r = toNum(eval1(e.r, env, ctx));
      switch (op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
        case "//": return Math.floor(l / r);
        case "%": return l - Math.floor(l / r) * r;
        case "^": return Math.pow(l, r);
        default: throw new LuaError(`unknown operator ${op}`);
      }
    }
  }
}

function evalCallFull(e: Expr & { t: "call" }, env: Scope, ctx: Ctx): LuaValue[] {
  const fnv = eval1(e.fn, env, ctx);
  const args = evalArgs(e.args, env, ctx);
  return callValue(fnv, args, ctx);
}

// ---------------------------------------------------------------------------
// Minimal Lua-pattern matcher for string.find
// ---------------------------------------------------------------------------

type Quant = "" | "*" | "+" | "-" | "?";

interface PatItem {
  cls: (c: string) => boolean;
  quant: Quant;
}

function isDigitC(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isAlphaC(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}
function isAlnumC(c: string): boolean {
  return isAlphaC(c) || isDigitC(c);
}
function isSpaceC(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r";
}
function isPunctC(c: string): boolean {
  const code = c.charCodeAt(0);
  return code > 32 && code < 127 && !isAlnumC(c);
}
function isUpperC(c: string): boolean {
  return c >= "A" && c <= "Z";
}
function isLowerC(c: string): boolean {
  return c >= "a" && c <= "z";
}
function isHexC(c: string): boolean {
  return isDigitC(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}
function isCtrlC(c: string): boolean {
  const code = c.charCodeAt(0);
  return code < 32 || code === 127;
}

function classPred(d: string): (c: string) => boolean {
  switch (d) {
    case "d": return isDigitC;
    case "D": return (c) => !isDigitC(c);
    case "a": return isAlphaC;
    case "A": return (c) => !isAlphaC(c);
    case "w": return isAlnumC;
    case "W": return (c) => !isAlnumC(c);
    case "s": return isSpaceC;
    case "S": return (c) => !isSpaceC(c);
    case "p": return isPunctC;
    case "P": return (c) => !isPunctC(c);
    case "x": return isHexC;
    case "X": return (c) => !isHexC(c);
    case "c": return isCtrlC;
    case "C": return (c) => !isCtrlC(c);
    case "u": return isUpperC;
    case "l": return isLowerC;
    default: return (c) => c === d; // escaped literal
  }
}

interface CompiledPat {
  items: PatItem[];
  anchorStart: boolean;
  anchorEnd: boolean;
}

function compilePat(p: string): CompiledPat {
  let anchorStart = false;
  let anchorEnd = false;
  let i = 0;
  if (p[i] === "^") {
    anchorStart = true;
    i++;
  }
  if (p.length > 1 && p[p.length - 1] === "$" && p[p.length - 2] !== "%") {
    anchorEnd = true;
    p = p.slice(0, -1);
  }
  const items: PatItem[] = [];
  while (i < p.length) {
    let cls: (c: string) => boolean;
    const ch = p[i];
    if (ch === "%") {
      const d = p[i + 1];
      if (d === undefined) throw new LuaError("malformed pattern (ends with '%')");
      cls = classPred(d);
      i += 2;
    } else if (ch === ".") {
      cls = () => true;
      i++;
    } else if (ch === "$") {
      throw new LuaError("malformed pattern ('$' in the middle)");
    } else {
      const lit = ch;
      cls = (c) => c === lit;
      i++;
    }
    let quant: Quant = "";
    const q = p[i];
    if (q === "*" || q === "+" || q === "-" || q === "?") {
      quant = q;
      i++;
    }
    items.push({ cls, quant });
  }
  return { items, anchorStart, anchorEnd };
}

function matchRec(items: PatItem[], k: number, pos: number, s: string, ctx: Ctx): number {
  tick(ctx);
  if (k === items.length) return pos;
  const it = items[k];
  if (it.quant === "") {
    if (pos < s.length && it.cls(s[pos])) return matchRec(items, k + 1, pos + 1, s, ctx);
    return -1;
  }
  const min = it.quant === "+" ? 1 : 0;
  const greedy = it.quant !== "-";
  const candidates: number[] = [pos];
  let p = pos;
  while (p < s.length && it.cls(s[p])) {
    p++;
    candidates.push(p);
  }
  if (greedy) candidates.reverse();
  for (const pp of candidates) {
    if (pp - pos < min) continue;
    const r = matchRec(items, k + 1, pp, s, ctx);
    if (r >= 0) return r;
    if (!greedy) break;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Host standard libraries (closures only; no host state exposed as values)
// ---------------------------------------------------------------------------

let tableIdCounter = 0;
function nextTableId(): number {
  return ++tableIdCounter;
}

function makeStdLibs(ctx: Ctx): { math: LTable; string: LTable; table: LTable } {
  const mkTable = (): LTable => new LTable(nextTableId());

  const mustTable = (v: LuaValue, what: string): LTable => {
    if (!(v instanceof LTable)) throw new LuaError(`bad argument to '${what}' (table expected)`);
    return v;
  };

  const math = mkTable();
  const setFn = (t: LTable, name: string, fn: LuaFunc): void => {
    t.map.set(name, fn);
    t.entries++;
  };

  setFn(math, "floor", (a) => [Math.floor(toNum(a[0]))]);
  setFn(math, "ceil", (a) => [Math.ceil(toNum(a[0]))]);
  setFn(math, "abs", (a) => [Math.abs(toNum(a[0]))]);
  setFn(math, "sqrt", (a) => [Math.sqrt(toNum(a[0]))]);
  setFn(math, "min", (a) => {
    if (a.length === 1) {
      const t = mustTable(a[0], "math.min");
      const ks = allPairs(t).map((e) => toNum(e.v));
      if (ks.length === 0) throw new LuaError("bad argument #1 to 'math.min' (empty table)");
      return [ks.reduce((m, x) => (x < m ? x : m))];
    }
    const nums = a.map(toNum);
    return [nums.reduce((m, x) => (x < m ? x : m))];
  });
  setFn(math, "max", (a) => {
    if (a.length === 1) {
      const t = mustTable(a[0], "math.max");
      const ks = allPairs(t).map((e) => toNum(e.v));
      if (ks.length === 0) throw new LuaError("bad argument #1 to 'math.max' (empty table)");
      return [ks.reduce((m, x) => (x > m ? x : m))];
    }
    const nums = a.map(toNum);
    return [nums.reduce((m, x) => (x > m ? x : m))];
  });

  let rngState = 0x12345678;
  setFn(math, "random", (a) => {
    rngState = (Math.imul(rngState, 1103515245) + 12345) >>> 0;
    const u = rngState / 4294967296; // [0,1)
    if (a.length === 0) return [u];
    const m = Math.floor(toNum(a[0]));
    if (a.length === 1) return [Math.floor(u * m) + 1]; // 1..m
    const lo = Math.floor(toNum(a[0]));
    const hi = Math.floor(toNum(a[1]));
    if (hi < lo) throw new LuaError("bad interval to 'math.random'");
    return [Math.floor(u * (hi - lo + 1)) + lo]; // lo..hi
  });
  setFn(math, "randomseed", (a) => {
    rngState = Math.floor(toNum(a[0])) >>> 0;
    return [];
  });

  const strLib = mkTable();
  setFn(strLib, "len", (a) => [checkStr(a[0] ?? null).length]);
  setFn(strLib, "upper", (a) => [checkStrLen(checkStr(a[0] ?? null).toUpperCase())]);
  setFn(strLib, "lower", (a) => [checkStrLen(checkStr(a[0] ?? null).toLowerCase())]);
  setFn(strLib, "sub", (a) => {
    const s = checkStr(a[0] ?? null);
    const len = s.length;
    let i = Math.trunc(toNum(a[1] ?? null));
    let j = a.length >= 3 && a[2] !== null && a[2] !== undefined ? Math.trunc(toNum(a[2])) : -1;
    if (i < 0) i = Math.max(len + i + 1, 0);
    if (j < 0) j = len + j + 1;
    j = Math.min(j, len);
    if (i < 1) i = 1;
    if (j < i) return [""];
    return [s.slice(i - 1, j)];
  });
  setFn(strLib, "rep", (a) => {
    const s = checkStr(a[0] ?? null);
    const n = Math.trunc(toNum(a[1] ?? null));
    if (n < 0 || !Number.isFinite(n)) throw new LuaError("bad repetition count to 'string.rep'");
    const sep = a.length >= 3 ? checkStr(a[2] ?? null) : "";
    if (n === 0) return [""];
    if (s.length * n + sep.length * (n - 1) > MAX_STRING) {
      throw new LuaError(`string too long (limit ${MAX_STRING})`);
    }
    return [checkStrLen(Array(n).fill(s).join(sep))];
  });
  setFn(strLib, "find", (a) => {
    const s = checkStr(a[0] ?? null);
    const pat = checkStr(a[1] ?? null);
    const initRaw = a.length >= 3 && a[2] !== null && a[2] !== undefined ? Math.trunc(toNum(a[2])) : 1;
    let init = initRaw < 0 ? s.length + initRaw : initRaw - 1;
    if (init < 0) init = 0;
    if (init > s.length) return [null];
    const plain = a.length >= 4 ? truthy(a[3]) : false;
    if (plain) {
      const idx = s.indexOf(pat, init);
      if (idx < 0) return [null];
      return [idx + 1, idx + pat.length];
    }
    const cp = compilePat(pat);
    const starts = cp.anchorStart ? [init] : null;
    const from = init;
    const to = s.length;
    for (let st = from; st <= to; st++) {
      if (starts !== null && st > starts[0]) break;
      tick(ctx);
      const end = matchRec(cp.items, 0, st, s, ctx);
      if (end >= 0 && (!cp.anchorEnd || end === s.length)) return [st + 1, end];
    }
    return [null];
  });
  setFn(strLib, "format", (a) => {
    const f = checkStr(a[0] ?? null);
    const rest = a.slice(1);
    return [strFormat(f, rest)];
  });

  const tblLib = mkTable();
  setFn(tblLib, "insert", (a) => {
    const t = mustTable(a[0] ?? null, "table.insert");
    if (a.length >= 3) {
      const pos = Math.trunc(toNum(a[1] ?? null));
      const v = a[2];
      const len = t.arr.length + 1;
      if (pos < 1 || pos > len) throw new LuaError("bad position to 'table.insert'");
      if (t.entries + 1 > MAX_TABLE) throw new LuaError(`table size limit exceeded (${MAX_TABLE})`);
      t.arr.splice(pos - 1, 0, v ?? null);
      t.entries++;
    } else {
      tset(t, t.arr.length + 1, a[1] ?? null);
    }
    return [];
  });
  setFn(tblLib, "remove", (a) => {
    const t = mustTable(a[0] ?? null, "table.remove");
    const pos = a.length >= 2 ? Math.trunc(toNum(a[1] ?? null)) : t.arr.length;
    if (pos < 1 || pos > t.arr.length) return [null];
    const removed = t.arr.splice(pos - 1, 1)[0] ?? null;
    if (removed !== null) t.entries--;
    return [removed];
  });
  setFn(tblLib, "concat", (a) => {
    const t = mustTable(a[0] ?? null, "table.concat");
    const sep = a.length >= 2 ? checkStr(a[1] ?? null) : "";
    const i = a.length >= 3 ? Math.trunc(toNum(a[2] ?? null)) : 1;
    const j = a.length >= 4 ? Math.trunc(toNum(a[3] ?? null)) : tlen(t);
    const parts: string[] = [];
    for (let k = i; k <= j; k++) {
      const v = tget(t, k);
      if (v === null || (typeof v !== "string" && typeof v !== "number")) {
        throw new LuaError("invalid value in table to 'table.concat'");
      }
      parts.push(typeof v === "number" ? fmtNum(v) : v);
    }
    return [checkStrLen(parts.join(sep))];
  });

  return { math, string: strLib, table: tblLib };
}

function strFormat(f: string, args: LuaValue[]): string {
  let out = "";
  let ai = 0;
  let k = 0;
  while (k < f.length) {
    const c = f[k];
    if (c !== "%") {
      out += c;
      k++;
      continue;
    }
    k++;
    if (f[k] === "%") {
      out += "%";
      k++;
      continue;
    }
    let flags = "";
    while (k < f.length && "-+ #0".includes(f[k])) {
      flags += f[k];
      k++;
    }
    let width = 0;
    while (k < f.length && isDigitC(f[k])) {
      width = width * 10 + (f.charCodeAt(k) - 48);
      k++;
    }
    let prec: number | null = null;
    if (f[k] === ".") {
      k++;
      let ps = 0;
      let any = false;
      while (k < f.length && isDigitC(f[k])) {
        ps = ps * 10 + (f.charCodeAt(k) - 48);
        any = true;
        k++;
      }
      prec = any ? ps : 0;
    }
    const conv = f[k];
    if (conv === undefined) throw new LuaError("malformed format string");
    k++;
    const arg = args[ai] ?? null;
    ai++;
    let s: string;
    switch (conv) {
      case "s":
        s = toStrAny(arg);
        if (prec !== null) s = s.slice(0, prec);
        break;
      case "d":
      case "i":
      case "u": {
        s = String(Math.trunc(toNum(arg)));
        if (flags.includes("+") && Math.trunc(toNum(arg)) >= 0) s = "+" + s;
        break;
      }
      case "x":
      case "X": {
        s = (Math.trunc(toNum(arg)) >>> 0).toString(16);
        if (conv === "X") s = s.toUpperCase();
        break;
      }
      case "o":
        s = (Math.trunc(toNum(arg)) >>> 0).toString(8);
        break;
      case "f":
        s = toNum(arg).toFixed(prec ?? 6);
        break;
      case "e":
      case "E":
        s = toNum(arg).toExponential(prec ?? 6);
        if (conv === "E") s = s.toUpperCase();
        break;
      case "g":
        s = fmtNum(toNum(arg));
        break;
      case "c":
        s = String.fromCharCode(Math.trunc(toNum(arg)) & 0xff);
        break;
      case "q":
        s = JSON.stringify(typeof arg === "string" ? arg : toStrAny(arg));
        break;
      default:
        throw new LuaError(`invalid conversion '%${conv}' to 'string.format'`);
    }
    if (width > s.length) {
      if (flags.includes("-")) s = s.padEnd(width);
      else if (flags.includes("0")) s = s.padStart(width, "0");
      else s = s.padStart(width);
    }
    out = checkStrLen(out + s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// runBlockScript
// ---------------------------------------------------------------------------

export function runBlockScript(
  src: string,
  fn: string,
  // `x/y/z` are the cell the script belongs to; they arrive as globals too, so
  // an author never has to thread coordinates through a function signature.
  args: { player: string; key?: string; x?: number; y?: number; z?: number },
  state: ScriptState,
  // Preloaded host facts the run may read and change: the acting player's
  // position, their item stacks, and this cell's own store. Nothing is written
  // back here — the caller flushes what `outcome` records.
  opts?: {
    maxInstructions?: number;
    wallMs?: number;
    pos?: { x: number; y: number; z: number } | null;
    stacks?: Map<string, number>;
    inv?: Map<string, number>;
    missingEntryIsNoop?: boolean;
  }
): ScriptOutcome {
  const beams: { colour: string }[] = [];
  const toasts: string[] = [];
  const logs: string[] = [];
  const moves: { kind: "position" | "respawn"; x: number; y: number; z: number }[] = [];
  const gives: { item: string; qty: number }[] = [];
  const takes: { item: string; qty: number }[] = [];
  const outcome: ScriptOutcome = { ok: true, beams, toasts, logs, moves, gives, takes, stored: [] };
  const stacks = opts?.stacks ?? new Map<string, number>();
  const inv = opts?.inv ?? new Map<string, number>();
  // Every id the cell ever held this run, including ones emptied to 0: those
  // have to come out of the table, so the caller needs to hear about them.
  const invKeys = new Set<string>(inv.keys());
  const ctx: Ctx = {
    steps: 0,
    maxSteps: opts?.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS,
    start: Date.now(),
    wallMs: opts?.wallMs ?? DEFAULT_WALL_MS,
    calls: 0,
  };
  let menu: { title: string; options: { key: string; label: string }[] } | undefined;

  try {
    if (typeof src !== "string") throw new LuaError("script source must be a string");

    const toks = lex(src);
    const body = new Parser(toks).parseChunk();

    const libs = makeStdLibs(ctx);
    const globals: Scope = { vars: new Map(), parent: null };

    const setHost = (name: string, fn: LuaFunc): void => {
      globals.vars.set(name, fn);
    };

    globals.vars.set("player", String(args.player ?? ""));
    globals.vars.set("key", typeof args.key === "string" ? args.key : null);
    globals.vars.set("x", typeof args.x === "number" ? args.x : 0);
    globals.vars.set("y", typeof args.y === "number" ? args.y : 0);
    globals.vars.set("z", typeof args.z === "number" ? args.z : 0);

    setHost("state_get", (a) => {
      const k = checkStr(a[0] ?? null);
      const v = state.get(k);
      if (v === null || v === undefined) return [null];
      if (typeof v === "number" && !Number.isFinite(v)) return [null];
      return [typeof v === "string" || typeof v === "number" ? v : String(v)];
    });
    setHost("state_set", (a) => {
      const k = checkStr(a[0] ?? null);
      if (k.length > MAX_STATE_KEY) throw new LuaError(`state key too long (limit ${MAX_STATE_KEY})`);
      const v = a.length >= 2 ? a[1] : null;
      if (v === null || v === undefined) {
        state.set(k, null);
      } else if (typeof v === "number") {
        if (!Number.isFinite(v)) throw new LuaError("state value must be finite");
        state.set(k, v);
      } else if (typeof v === "string") {
        state.set(k, v.length > MAX_STATE_VALUE ? v.slice(0, MAX_STATE_VALUE) : v);
      } else if (typeof v === "boolean") {
        const s = v ? "true" : "false";
        state.set(k, s);
      } else {
        throw new LuaError("state value must be nil, string or number");
      }
      return [];
    });

    // Menu options, in whichever shape the author wrote them:
    //   { red = "Red", blue = "Blue" }              key -> label
    //   { { "red", "Red" }, … }                    positional pairs
    //   { { key = "red", label = "Red" }, … }       named fields
    const readMenuOptions = (optsTable: LTable): { key: string; label: string }[] => {
      const entries = allPairs(optsTable);
      if (entries.length > MAX_MENU_OPTIONS) {
        throw new LuaError(`too many menu options (limit ${MAX_MENU_OPTIONS})`);
      }
      const arrayForm =
        entries.length > 0 &&
        entries.every((e, idx) => e.k === idx + 1 && e.v instanceof LTable);
      const options: { key: string; label: string }[] = [];
      for (const e of entries) {
        const item = arrayForm ? (e.v as LTable) : null;
        const rawKey = item ? tget(item, 1) ?? tget(item, "key") : e.k;
        const rawLabel = item ? tget(item, 2) ?? tget(item, "label") : e.v;
        const key =
          rawKey === null || rawKey === undefined ? ""
          : typeof rawKey === "string" ? rawKey
          : typeof rawKey === "number" ? fmtNum(rawKey)
          : "";
        if (key === "" || key.length > MAX_MENU_KEY) {
          throw new LuaError(`bad menu option key (1..${MAX_MENU_KEY} chars expected)`);
        }
        if (typeof rawLabel !== "string" && typeof rawLabel !== "number") {
          throw new LuaError("bad menu option label (string expected)");
        }
        options.push({ key, label: concatStr(rawLabel) });
      }
      return options;
    };

    setHost("menu", (a) => {
      const title = a.length >= 1 ? toStrAny(a[0]) : "";
      const optsTable = a[1];
      if (!(optsTable instanceof LTable)) {
        throw new LuaError("bad argument #2 to 'menu' (options table expected)");
      }
      menu = { title: checkStrLen(title), options: readMenuOptions(optsTable) };
      outcome.menu = menu;
      return [];
    });

    setHost("beam", (a) => {
      const v = a.length >= 1 ? a[0] : null;
      const colour = v === null || v === undefined ? "" : checkStr(v);
      if (colour.length > MAX_BEAM_COLOUR) {
        throw new LuaError(`beam colour too long (limit ${MAX_BEAM_COLOUR})`);
      }
      if (beams.length + 1 > MAX_OUTPUT_ITEMS) {
        throw new LuaError(`too many beams (limit ${MAX_OUTPUT_ITEMS})`);
      }
      beams.push({ colour });
      return [];
    });

    setHost("toast", (a) => {
      if (toasts.length + 1 > MAX_OUTPUT_ITEMS) {
        throw new LuaError(`too many toasts (limit ${MAX_OUTPUT_ITEMS})`);
      }
      toasts.push(toStrAny(a.length >= 1 ? a[0] : null).slice(0, MAX_STATE_VALUE));
      return [];
    });

    setHost("log", (a) => {
      if (logs.length + 1 > MAX_OUTPUT_ITEMS) {
        throw new LuaError(`too many logs (limit ${MAX_OUTPUT_ITEMS})`);
      }
      logs.push(toStrAny(a.length >= 1 ? a[0] : null).slice(0, MAX_STATE_VALUE));
      return [];
    });

    // ---- the acting player: where they stand, where they wake up -----------
    // Deliberately argument-free about WHO: every one of these acts on the
    // player who pressed the key, so a block script cannot reach around them to
    // someone else. The moves are recorded, not applied: the caller writes them
    // in its own transaction and tells the live object.
    setHost("get_player_position", () => {
      const p = opts?.pos ?? null;
      return p ? [p.x, p.y, p.z] : [null];
    });
    const checkCoord = (v: LuaValue, name: string): number => {
      const n = toNum(v);
      if (!Number.isFinite(n) || Math.abs(n) > 1_000_000) throw new LuaError(`'${name}' must be a finite coordinate`);
      return n;
    };
    const recordMove = (host: string, a: LuaValue[]): LuaValue[] => {
      if (a.length < 3) throw new LuaError(`'${host}' expects a position (x, y, z)`);
      if (moves.length + 1 > MAX_MOVES) throw new LuaError(`too many moves (limit ${MAX_MOVES})`);
      moves.push({
        kind: host === "set_player_respawn_position" ? "respawn" : "position",
        x: checkCoord(a[0], "x"), y: checkCoord(a[1], "y"), z: checkCoord(a[2], "z")
      });
      return [];
    };
    setHost("set_player_position", (a) => recordMove("set_player_position", a));
    setHost("set_player_respawn_position", (a) => recordMove("set_player_respawn_position", a));

    // ---- items: the player's stacks, and the cell's own store --------------
    const checkItem = (v: LuaValue, host: string): string => {
      const id = checkStr(v);
      if (id.length > MAX_STATE_VALUE || !ITEM_ID.test(id)) throw new LuaError(`bad argument #1 to '${host}' (unknown item id)`);
      return id;
    };
    const checkQty = (v: LuaValue, host: string): number => {
      const q = Math.trunc(toNum(v));
      if (!(q >= 1 && q <= MAX_STACK)) throw new LuaError(`bad argument #2 to '${host}' (quantity must be 1..${MAX_STACK})`);
      return q;
    };
    setHost("give_item", (a) => {
      const item = checkItem(a[0] ?? null, "give_item");
      const qty = checkQty(a[1] ?? null, "give_item");
      const now = stacks.get(item) ?? 0;
      const added = Math.min(qty, MAX_STACK - now);
      if (added > 0) { stacks.set(item, now + added); gives.push({ item, qty: added }); }
      return [now + added];
    });
    setHost("take_item", (a) => {
      const item = checkItem(a[0] ?? null, "take_item");
      const qty = checkQty(a[1] ?? null, "take_item");
      const now = stacks.get(item) ?? 0;
      const removed = Math.min(qty, now);
      if (removed > 0) { stacks.set(item, now - removed); takes.push({ item, qty: removed }); }
      return [removed];
    });
    setHost("item_count", (a) => [stacks.get(checkItem(a[0] ?? null, "item_count")) ?? 0]);
    setHost("inv_add", (a) => {
      const item = checkItem(a[0] ?? null, "inv_add");
      const qty = checkQty(a[1] ?? null, "inv_add");
      const now = inv.get(item) ?? 0;
      if (now === 0 && invKeys.size + 1 > MAX_INV_ITEMS) {
        throw new LuaError(`too many kinds of item in one block (limit ${MAX_INV_ITEMS})`);
      }
      const added = Math.min(qty, MAX_STACK - now);
      inv.set(item, now + added);
      invKeys.add(item);
      return [now + added];
    });
    setHost("inv_take", (a) => {
      const item = checkItem(a[0] ?? null, "inv_take");
      const qty = checkQty(a[1] ?? null, "inv_take");
      const now = inv.get(item) ?? 0;
      const removed = Math.min(qty, now);
      inv.set(item, now - removed);
      invKeys.add(item);
      return [removed];
    });
    setHost("inv_count", (a) => [inv.get(checkItem(a[0] ?? null, "inv_count")) ?? 0]);
    setHost("inv_list", () => {
      const listed = new LTable(nextTableId());
      for (const [item, qty] of inv) if (qty > 0) tset(listed, item, qty);
      return [listed];
    });

    globals.vars.set("math", libs.math);
    globals.vars.set("string", libs.string);
    globals.vars.set("table", libs.table);

    setHost("tonumber", (a) => {
      const v = a[0] ?? null;
      const base = a.length >= 2 && a[1] !== null && a[1] !== undefined ? Math.trunc(toNum(a[1])) : null;
      if (typeof v === "number") return [base === null ? v : Number.isInteger(v) ? v : null];
      if (typeof v !== "string") return [null];
      if (base === null) return [parseNumStrict(v)];
      if (base < 2 || base > 36) throw new LuaError("bad base to 'tonumber'");
      const t = v.trim();
      if (!/^[+-]?[0-9a-zA-Z]+$/.test(t)) return [null];
      const n = parseInt(t, base);
      return [Number.isNaN(n) ? null : n];
    });
    setHost("tostring", (a) => [toStrAny(a[0] ?? null)]);
    setHost("type", (a) => [typeName(a[0] ?? null)]);

    setHost("pairs", (a) => {
      const t = a[0];
      if (!(t instanceof LTable)) throw new LuaError("bad argument #1 to 'pairs' (table expected)");
      const iter: LuaFunc = (itArgs) => {
        const ctrl = itArgs[0];
        const prev = itArgs[1] ?? null;
        if (!(ctrl instanceof LTable)) throw new LuaError("bad 'pairs' control value");
        const k = nextKey(ctrl, typeof prev === "number" ? prev : prev);
        if (k === null) return [null];
        return [k, tget(ctrl, k)];
      };
      return [iter, t, null];
    });
    setHost("ipairs", (a) => {
      const t = a[0];
      if (!(t instanceof LTable)) throw new LuaError("bad argument #1 to 'ipairs' (table expected)");
      const iter: LuaFunc = (itArgs) => {
        const ctrl = itArgs[0];
        const prev = itArgs[1] ?? null;
        if (!(ctrl instanceof LTable)) throw new LuaError("bad 'ipairs' control value");
        const i = (typeof prev === "number" ? prev : 0) + 1;
        const v = tget(ctrl, i);
        if (v === null) return [null];
        return [i, v];
      };
      return [iter, t, null];
    });

    try {
      execBlock(body, globals, ctx);
    } catch (r) {
      if (!(r instanceof ReturnSignal)) throw r; // top-level return just ends the chunk
    }

    const target = globals.vars.get(fn) ?? null;
    if (typeof target !== "function") {
      // A block broken, opened or clicked by a script that never defined this
      // hook is not a broken script — the caller asked on spec.
      if (opts?.missingEntryIsNoop) return outcome;
      throw new LuaError(`'${fn}' is not a function (got ${typeName(target)})`);
    }
    // Positional contract: on_interact(player) / on_choice(key, player) /
    // on_break(player). The globals `player`, `key` and the cell's `x/y/z`
    // carry the same information, so either style works.
    const callArgs: LuaValue[] = args.key !== undefined
      ? [args.key, String(args.player ?? "")]
      : [String(args.player ?? "")];
    const answer = callValue(target, callArgs, ctx);
    // A script may also answer with a table instead of calling menu():
    //   return { title = "…", options = { red = "Red", … } }
    const answered = answer && answer.length > 0 ? answer[0] : null;
    if (menu === undefined && answered instanceof LTable) {
      const options = tget(answered, "options");
      if (options instanceof LTable) {
        const title = tget(answered, "title");
        menu = {
          title: typeof title === "string" ? checkStrLen(title) : "",
          options: readMenuOptions(options)
        };
        outcome.menu = menu;
      }
    }

    // The cell's store is flushed as a whole: every id it held this run, with
    // the quantity it ended on (0 deletes the row).
    for (const item of invKeys) outcome.stored.push({ item, qty: inv.get(item) ?? 0 });

    return outcome;
  } catch (e) {
    const message = e instanceof LuaError ? e.message : "internal interpreter error";
    // A run that failed mid-way is rolled back, not partially applied: the
    // caller ignores everything recorded on this path.
    const failed: ScriptOutcome = { ok: false, error: message, beams, toasts, logs, moves, gives, takes, stored: [] };
    if (menu !== undefined) failed.menu = menu;
    return failed;
  }
}
