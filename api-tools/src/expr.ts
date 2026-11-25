/**
 * Tiny expression/template engine for the "Expression" field.
 *
 *   data.items[0].count                     plain path (legacy)
 *   {cpu.name}: {cpu.temp}                  template: {path} or {expression}
 *   ={a} + {b}                              math expression (leading "=")
 *   {time.hour}:{pad({time.minute}, 2)}     functions inside a template
 *   {name}[0:5]  {name}[:-1]  {name}[-1]    Python-style index / slice on any value
 *
 * Hand-written parser, no eval().
 */

type Val = unknown;

/** Resolve "a.b[0].c" against parsed JSON. */
export function extract(data: unknown, path: string): Val {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: any = data;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = Object.prototype.hasOwnProperty.call(Object(cur), p) ? cur[p] : undefined;
  }
  return cur;
}

function fmt(v: Val): string {
  if (v === undefined || v === null) return "n/a";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "n/a";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  return JSON.stringify(v) ?? "n/a";
}

/** Remove float noise (0.1+0.2) from computed results only; raw values stay exact. */
const clean = (n: number) => (Number.isInteger(n) || !Number.isFinite(n) ? n : Number(n.toPrecision(12)));

// Runs on API values, so it must not backtrack: "\d+\.?\d*" would take quadratic time on a long run of digits.
const NUMERIC = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?\s*$/;

function toNum(v: Val): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && NUMERIC.test(v)) return Number(v);
  return NaN;
}

function add(a: Val, b: Val): Val {
  const x = toNum(a), y = toNum(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return clean(x + y);
  if (a === undefined || a === null || b === undefined || b === null) return NaN;
  return fmt(a) + fmt(b);
}

// i, a:b, a:b:c; each part optional in a slice, and a "-" must be followed by digits.
const SLICE_SPEC = /^(?:-?\d+)?(?::(?:-?\d+)?){0,2}$/;

/** Python-style s[i] / s[a:b:c] on a string (by code point). */
function pySlice(s: string, spec: string): string {
  const chars = Array.from(s);
  const n = chars.length;
  spec = spec.replace(/\s+/g, "");

  if (!spec.includes(":")) {
    let i = Number(spec);
    if (i < 0) i += n;
    return chars[i] ?? "";
  }

  const [a, b, c] = spec.split(":");
  const step = c ? Number(c) : 1;
  if (step === 0) throw new Error("Slice step cannot be zero");
  const lower = step < 0 ? -1 : 0;
  const upper = step < 0 ? n - 1 : n;
  const norm = (x: number) => {
    if (x < 0) {
      x += n;
      if (x < lower) x = lower;
    } else if (x > upper) x = upper;
    return x;
  };
  const start = a ? norm(Number(a)) : step < 0 ? upper : lower;
  const stop = b ? norm(Number(b)) : step < 0 ? lower : upper;

  let out = "";
  if (step > 0) for (let i = start; i < stop; i += step) out += chars[i];
  else for (let i = start; i > stop; i += step) out += chars[i];
  return out;
}

const FUNCS: Record<string, (...a: Val[]) => Val> = {
  round: (x, d = 0) => {
    const n = toNum(x);
    const digits = Math.trunc(toNum(d));
    if (!Number.isFinite(n) || !Number.isFinite(digits)) return NaN;
    const dg = Math.min(Math.max(digits, -20), 20);
    const abs = Math.abs(n);
    if (abs >= 1e21) return n; // no decimals to round, and the shifting below would lose precision
    const sign = n < 0 ? -1 : 1;
    // Shift via exponent notation so 1.005 -> 100.5 exactly (no float error); halves round away from zero.
    if (!String(abs).includes("e")) {
      const shifted = Math.round(Number(`${abs}e${dg}`));
      // Past 1e21 the shifted value prints in exponent form ("1e+25e-20" would be NaN); it has no digits left to round.
      if (String(shifted).includes("e")) return clean(n);
      return clean(sign * Number(`${shifted}e${-dg}`));
    }
    const f = 10 ** dg;
    return clean(sign * (Math.round(abs * f) / f));
  },
  // Fixed decimals as text: fixed(5, 1) -> "5.0", fixed(2.25, 1) -> "2.3". Default 1 digit.
  fixed: (x, d = 1) => {
    const n = toNum(x);
    const dg = Math.min(Math.max(Math.trunc(toNum(d)), 0), 20);
    if (!Number.isFinite(n) || !Number.isFinite(dg)) return NaN;
    return (FUNCS.round(n, dg) as number).toFixed(dg);
  },
  floor: (x) => Math.floor(toNum(x)),
  ceil: (x) => Math.ceil(toNum(x)),
  abs: (x) => Math.abs(toNum(x)),
  min: (...a) => Math.min(...a.map(toNum)),
  max: (...a) => Math.max(...a.map(toNum)),
  pad: (x, w, c = "0") => {
    const width = Math.min(Math.max(toNum(w) || 0, 0), 200);
    const str = fmt(x);
    const fill = fmt(c);
    // Like Python's zfill: keep the sign in front of zero padding ("-5" -> "-005").
    if (fill === "0" && /^[-+]/.test(str)) return str[0] + str.slice(1).padStart(Math.max(width - 1, 0), "0");
    return str.padStart(width, fill);
  },
};

class Parser {
  private i = 0;
  /** `strict` (URL templates): a {path} with no value throws instead of flowing on as "n/a". */
  constructor(private s: string, private data: unknown, private strict = false) {}

  parse(): Val {
    const v = this.expr();
    this.ws();
    if (this.i < this.s.length) throw new Error(`Unexpected "${this.s[this.i]}" at ${this.i}`);
    return v;
  }

  private ws() { while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i++; }
  private peek() { this.ws(); return this.s[this.i]; }
  private expect(c: string) {
    if (this.peek() !== c) throw new Error(`Expected "${c}" at ${this.i}`);
    this.i++;
  }

  private expr(): Val {
    let l = this.term();
    for (let op = this.peek(); op === "+" || op === "-"; op = this.peek()) {
      this.i++;
      const r = this.term();
      l = op === "+" ? add(l, r) : clean(toNum(l) - toNum(r));
    }
    return l;
  }

  private term(): Val {
    let l = this.unary();
    for (let op = this.peek(); op === "*" || op === "/" || op === "%"; op = this.peek()) {
      this.i++;
      const r = toNum(this.unary());
      const x = toNum(l);
      l = clean(op === "*" ? x * r : op === "/" ? x / r : x % r);
    }
    return l;
  }

  private unary(): Val {
    if (this.peek() === "-") {
      this.i++;
      return -toNum(this.unary());
    }
    return this.primary();
  }

  /** A value followed by any number of [index] / [a:b:c] suffixes. */
  private primary(): Val {
    let v = this.atom();
    while (this.peek() === "[") {
      const end = this.s.indexOf("]", this.i);
      if (end < 0) throw new Error("Missing ]");
      const spec = this.s.slice(this.i + 1, end).replace(/\s+/g, "");
      if (spec === "" || !SLICE_SPEC.test(spec)) throw new Error(`Bad slice "[${spec}]"`);
      this.i = end + 1;
      v = v === undefined || v === null ? undefined : pySlice(fmt(v), spec);
    }
    return v;
  }

  private atom(): Val {
    const c = this.peek();
    if (c === undefined) throw new Error("Unexpected end of expression");

    if (c === "(") {
      this.i++;
      const v = this.expr();
      this.expect(")");
      return v;
    }
    if (c === "{") {
      const end = this.s.indexOf("}", this.i);
      if (end < 0) throw new Error("Missing }");
      const path = this.s.slice(this.i + 1, end).trim();
      this.i = end + 1;
      const v = extract(this.data, path);
      if (this.strict && (v === undefined || v === null)) throw new Error(`No value for {${path}}`);
      return v;
    }
    if (c === '"' || c === "'") {
      const end = this.s.indexOf(c, this.i + 1);
      if (end < 0) throw new Error("Unterminated string");
      const str = this.s.slice(this.i + 1, end);
      this.i = end + 1;
      return str;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.s.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return Number(num[0]);
    }
    const id = /^[A-Za-z_]\w*/.exec(this.s.slice(this.i));
    if (id) {
      this.i += id[0].length;
      // Own properties only, so "constructor(…)", "toString(…)" etc. aren't reachable via the prototype.
      const fn = Object.prototype.hasOwnProperty.call(FUNCS, id[0]) ? FUNCS[id[0]] : undefined;
      if (!fn) throw new Error(`Unknown function "${id[0]}"`);
      this.expect("(");
      const args: Val[] = [];
      if (this.peek() !== ")") {
        do args.push(this.expr());
        while (this.peek() === "," && ++this.i);
      }
      this.expect(")");
      return fn(...args);
    }
    throw new Error(`Unexpected "${c}" at ${this.i}`);
  }
}

/**
 * Fill `{...}` blocks in a template; each block is a path or an expression.
 * With `url` set (URL templates): every value is percent-encoded, `{!path}` inserts it raw,
 * and a missing value throws instead of printing "n/a".
 */
function template(t: string, data: unknown, url = false): string {
  let out = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "{") {
      out += t[i];
      continue;
    }
    let depth = 1, j = i + 1, quote = "";
    while (j < t.length && depth > 0) {
      const ch = t[j];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    if (depth > 0) throw new Error("Missing }");
    let body = t.slice(i + 1, j - 1);
    let raw = false;
    if (url && body.trimStart().startsWith("!")) {
      raw = true;
      body = body.trimStart().slice(1);
    }
    const isExpr = body.includes("{") || /^\s*[A-Za-z_]\w*\s*\(/.test(body);
    const val = isExpr ? new Parser(body, data, url).parse() : extract(data, body.trim());
    if (url && (val === undefined || val === null || (typeof val === "number" && !Number.isFinite(val)))) {
      throw new Error(`No value for {${body.trim()}}`);
    }
    let text = fmt(val);
    // Optional Python-style suffix right after the block: {x}[0:5]
    while (t[j] === "[") {
      const m = /^\[([^\]]*)\]/.exec(t.slice(j));
      if (!m || m[1] === "" || !SLICE_SPEC.test(m[1])) break;
      text = pySlice(text, m[1]);
      j += m[0].length;
    }
    out += url && !raw ? encodeURIComponent(text) : text;
    i = j - 1;
  }
  return out;
}

/** Evaluate the field against parsed JSON. Throws on syntax errors. */
export function evaluate(expression: string, data: unknown): string {
  const e = expression.trim();
  if (e.startsWith("=")) return fmt(new Parser(e.slice(1), data).parse());
  if (!e.includes("{")) return fmt(extract(data, e));
  return template(e, data);
}

/** Fill a URL template such as `https://x.com/?tz={tz}`. Values are percent-encoded; `{!url}` is inserted raw. Throws if a value is missing. */
export function evaluateUrl(urlTemplate: string, data: unknown): string {
  return template(urlTemplate.trim(), data, true);
}
