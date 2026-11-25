/**
 * Turns an image supplied by an API into a data URI that is safe to hand to setImage().
 *
 * Accepts SVG (raw markup, or a data:image/svg+xml URI, base64 or percent-encoded) and
 * raster images (PNG/JPEG/GIF/WebP as a data URI, or bare base64). Returns undefined if the
 * value isn't one of those or fails the checks. The SVG filter is defensive, not a full
 * sanitizer: Stream Deck renders the image natively (no scripting), but we still refuse
 * anything that could run code or pull in external content.
 */

export const MAX_SVG_BYTES = 256 * 1024;
export const MAX_RASTER_BYTES = 512 * 1024;

const RASTER_URI = /^data:image\/(?:png|jpe?g|gif|webp)(?:;[\w=.+-]+)*;base64,([\s\S]*)$/i;

function sniffRaster(b: Buffer): "png" | "jpeg" | "gif" | "webp" | undefined {
  if (b.length >= 8 && b.toString("hex", 0, 8) === "89504e470d0a1a0a") return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return undefined;
}

/** Validate base64 image data and re-emit it with the type taken from the file's own header (not the claimed MIME type). */
function rasterToUri(b64: string): string | undefined {
  const clean = b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!clean || clean.length > Math.ceil((MAX_RASTER_BYTES * 4) / 3) + 8) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return undefined;
  const buf = Buffer.from(clean, "base64");
  if (buf.length > MAX_RASTER_BYTES) return undefined;
  const type = sniffRaster(buf);
  return type ? `data:image/${type};base64,${buf.toString("base64")}` : undefined;
}

const DATA_URI = /^data:image\/svg\+xml((?:;[\w=.+-]+)*),([\s\S]*)$/i;

// Elements that have no place in an icon, with or without a namespace prefix (<svg:script>). animate\w* also
// covers animateMotion / animateTransform / animateColor; handler is SVG Tiny 1.2's script element.
// A namespace prefix may use any letters, not just ASCII.
const PREFIX = String.raw`(?:[^\s=/>"'<:]+:)?`;
const FORBIDDEN_TAGS = new RegExp(String.raw`<\s*${PREFIX}(script|foreignObject|iframe|object|embed|audio|video|animate\w*|set|handler)\b|<!ENTITY`, "i");
const USE_TAG = new RegExp(String.raw`<\s*${PREFIX}use\b`, "i");
// <use> copies another element, and copies of copies multiply: a tiny file can expand to billions of shapes in the
// renderer. Plain repetition (chart markers, text drawn glyph by glyph) is fine, so the expanded size is limited.
const MAX_EXPANDED = 20_000;
const MAX_DEPTH = 200;

function decodeDataUri(value: string): string | undefined {
  if (value.length > 3 * MAX_SVG_BYTES + 1024) return undefined; // too big however it is encoded
  const m = DATA_URI.exec(value);
  if (!m) return undefined;
  if (/;base64$/i.test(m[1])) return Buffer.from(m[2], "base64").toString("utf8");
  // Like browsers: decode %XX runs and leave any other "%" as-is (so width="100%" in an unencoded URI works).
  // Bytes that aren't valid UTF-8 become U+FFFD (throwing and catching for each such run was slow).
  return m[2].replace(/(?:%[0-9a-f]{2})+/gi, (run) => Buffer.from(run.replaceAll("%", ""), "hex").toString("utf8"));
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  // not XML, but lenient parsers know them
  nbsp: "\u00a0", colon: ":", lpar: "(", rpar: ")", sol: "/", bsol: "\\", num: "#", semi: ";", comma: ",", period: ".",
  tab: "\t", newline: "\n", excl: "!", commat: "@", percnt: "%", equals: "=", lbrack: "[", rbrack: "]",
};

function codePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "\ufffd";
}

/** Decode &#117; &#x75; &amp; ... once, the way an XML parser would (the trailing ";" is optional here, to be strict about lenient parsers). */
function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));?/g, (full, dec, hex, name) =>
    dec ? codePoint(Number(dec)) : hex ? codePoint(parseInt(hex, 16)) : (Object.hasOwn(NAMED_ENTITIES, name.toLowerCase()) ? NAMED_ENTITIES[name.toLowerCase()] : full),
  );
}

/** Remove CSS comments in one pass (a lazy regex is quadratic on many unclosed openers). */
function stripCssComments(s: string): string {
  let out = "";
  let from = 0;
  for (let open = s.indexOf("/*"); open >= 0; open = s.indexOf("/*", from)) {
    const close = s.indexOf("*/", open + 2);
    if (close < 0) break;
    out += s.slice(from, open);
    from = close + 2;
  }
  return out + s.slice(from);
}

/** Decode CSS escapes (\75 , \000075, \u) and drop comments / line continuations. */
function decodeCssEscapes(s: string): string {
  return stripCssComments(s)
    .replace(/\\\r?\n/g, "")
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?|\\([\s\S])/g, (_m, hex, ch) => (hex ? codePoint(parseInt(hex, 16)) : ch));
}

// What must not survive in CSS / attribute text after decoding: anything that can fetch or run something.
const HIDDEN_FETCH = /@import|\burl\((?!\s*(?:['"]\s*)?#)|image-set\(|\bsrc\(|\bimage\(|cross-fade\(|expression\(|javascript:|vbscript:|-moz-binding|behavior\s*:/i;

/** Text from each <style> tag to its closing tag (or the end), found in a single forward pass. */
function styleBlocks(svg: string): string[] {
  const open = new RegExp(String.raw`<\s*${PREFIX}style\b`, "gi");
  const close = new RegExp(String.raw`<\s*/\s*${PREFIX}style\s*>`, "gi");
  const blocks: string[] = [];
  while (open.exec(svg)) {
    close.lastIndex = open.lastIndex;
    const end = close.exec(svg);
    blocks.push(svg.slice(open.lastIndex, end ? end.index : svg.length));
    if (!end) break;
    open.lastIndex = close.lastIndex;
  }
  return blocks;
}

/** True if an attribute value or <style> body, decoded as XML + CSS, contains something fetching. */
function hasHiddenFetch(svg: string): boolean {
  const views: string[] = [];
  for (const m of svg.matchAll(/(?<![\w:.-])[\w:.-]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) views.push(m[1] ?? m[2]);
  views.push(...styleBlocks(svg));
  return views.some((v) => HIDDEN_FETCH.test(decodeCssEscapes(decodeEntities(v))));
}

type Node = { children: Node[]; target?: string };

/** Element tree with ids and <use> targets, read in one forward pass. Undefined if nested too deeply. */
function elementTree(svg: string): { root: Node; ids: Map<string, Node[]> } | undefined {
  const root: Node = { children: [] };
  const ids = new Map<string, Node[]>();
  const open: { name: string; node: Node }[] = [];
  // Names can't contain these delimiters, and a match must start after one, so each run is scanned once.
  const attribute = /(?<=[\s"'/])([^\s=/"'<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

  for (let i = svg.indexOf("<"); i >= 0; i = svg.indexOf("<", i + 1)) {
    const skip = svg.startsWith("<!--", i) ? "-->" : svg.startsWith("<![CDATA[", i) ? "]]>" : undefined;
    if (skip) {
      const end = svg.indexOf(skip, i);
      if (end < 0) break;
      i = end + skip.length - 1;
      continue;
    }
    let end = i + 1;
    for (let quote = ""; end < svg.length; end++) {
      const c = svg[end];
      if (quote) quote = c === quote ? "" : quote;
      else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (end >= svg.length) break;
    const tag = svg.slice(i + 1, end);
    i = end;
    if (tag.startsWith("!") || tag.startsWith("?")) continue;

    const closing = tag.startsWith("/");
    const name = /^\/?\s*([^\s/>]*)/.exec(tag)![1];
    if (closing) {
      const at = open.map((e) => e.name).lastIndexOf(name);
      if (at >= 0) open.length = at;
      continue;
    }

    const node: Node = { children: [] };
    const isUse = name.slice(name.lastIndexOf(":") + 1).toLowerCase() === "use";
    for (const m of tag.matchAll(attribute)) {
      const key = m[1].slice(m[1].lastIndexOf(":") + 1).toLowerCase();
      if (key !== "id" && !(isUse && key === "href")) continue;
      const value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "").trim();
      if (key === "id") ids.set(value, [...(ids.get(value) ?? []), node]);
      else if (value.startsWith("#")) node.target = value.slice(1);
    }
    (open.length ? open[open.length - 1].node : root).children.push(node);
    if (!tag.endsWith("/")) {
      if (open.length >= MAX_DEPTH) return undefined;
      open.push({ name, node });
    }
  }
  return { root, ids };
}

/** True if following every <use> draws a bounded number of elements (and never loops). */
function useIsBounded(svg: string): boolean {
  const tree = elementTree(svg);
  if (!tree) return false;
  const sizes = new Map<Node, number>();
  const active = new Set<Node>();

  const size = (node: Node, depth: number): number => {
    const known = sizes.get(node);
    if (known !== undefined) return known;
    if (depth > MAX_DEPTH || active.has(node)) return Infinity;
    active.add(node);
    let total = 1;
    for (const child of node.children) {
      total += size(child, depth + 1);
      if (total > MAX_EXPANDED) break;
    }
    // Several elements with one id: assume the largest is the one drawn.
    const targets = node.target === undefined ? [] : (tree.ids.get(node.target) ?? []);
    let largest = 0;
    for (const target of targets) {
      largest = Math.max(largest, size(target, depth + 1));
      if (largest > MAX_EXPANDED) break;
    }
    total += largest;
    active.delete(node);
    sizes.set(node, total);
    return total;
  };
  return size(tree.root, 0) <= MAX_EXPANDED;
}

function svgToUri(input: string): string | undefined {
  let svg = input.trim();
  if (!svg) return undefined;

  if (/^data:/i.test(svg)) {
    const decoded = decodeDataUri(svg);
    if (decoded === undefined) return undefined;
    svg = decoded.trim();
  }

  if (Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES) return undefined;

  // Drop an XML prolog / DOCTYPE / comments before the root element.
  svg = svg.replace(/^(?:\s*(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*>))+/i, "").trimStart();
  if (!/^<svg[\s>]/i.test(svg)) return undefined;
  if (FORBIDDEN_TAGS.test(svg)) return undefined;
  if (USE_TAG.test(svg) && !useIsBounded(svg)) return undefined;

  svg = svg
    // event handler attributes (onclick=..., onload=...); also after "/" or a quote, which lenient parsers accept
    .replace(new RegExp(String.raw`(?<=[\s/"'])${PREFIX}on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)`, "gi"), "")
    // external references (any namespace prefix): keep only in-document (#id) and embedded raster images.
    // Embedded SVG is dropped: it would bypass this filter. The value is entity-decoded before it is judged.
    .replace(new RegExp(String.raw`(?<=[\s/"'])${PREFIX}href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"']+))`, "gi"), (full, _q, a, b, c) => {
      const target = decodeEntities(String(a ?? b ?? c ?? "")).trim();
      return target.startsWith("#") || /^data:image\/(?:png|jpe?g|gif|webp)(?:;[\w=.+-]+)*;base64,/i.test(target) ? full : "";
    })
    // CSS that fetches things
    .replace(/@import[^;]*;?/gi, "")
    // The ")" is optional so that every match succeeds; otherwise many unclosed "url(" take quadratic time.
    .replace(/url\(([^)]*)(\)?)/gi, (full, arg: string, closed: string) =>
      !closed || /^['"]?\s*#/.test(decodeEntities(arg).trim()) ? full : "none",
    );

  // The checks above only see the text as written. XML entities (&#117;rl(), CSS escapes (\75 rl() and
  // comments can spell the same thing differently, so look at attribute values and <style> text as the
  // XML / CSS parsers would read them, and refuse the icon if anything fetching is hiding in there.
  if (hasHiddenFetch(svg)) return undefined;

  // A standalone SVG needs the namespace on the root.
  if (!/^<svg\b[^>]*\sxmlns\s*=/i.test(svg)) {
    svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

// A polled key gets the same icon over and over; don't filter it again each time.
const CACHE_SIZE = 16;
const cache = new Map<string, string | undefined>();

/** SVG or raster image (data URI, raw SVG markup, or bare base64) -> safe data URI, or undefined. */
export function toIconDataUri(input: string): string | undefined {
  if (cache.has(input)) return cache.get(input);
  const uri = convert(input);
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(input, uri);
  return uri;
}

function convert(input: string): string | undefined {
  const v = input.trim();
  if (!v) return undefined;

  if (/^data:/i.test(v)) {
    const m = RASTER_URI.exec(v);
    return m ? rasterToUri(m[1]) : svgToUri(v);
  }
  if (v.startsWith("<")) return svgToUri(v);

  // Bare base64 (no data: prefix): a raster image, or base64-encoded SVG text.
  const raster = rasterToUri(v);
  if (raster) return raster;
  if (/^[A-Za-z0-9+/_\-\s]+={0,2}$/.test(v) && v.length >= 16 && v.length <= Math.ceil((MAX_SVG_BYTES * 4) / 3) + 8) {
    const text = Buffer.from(v.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").trimStart();
    if (/^(?:<\?xml|<svg)/i.test(text)) return svgToUri(text);
  }
  return undefined;
}

const xml = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** A red status tile with one or two lines of text, shown in place of the icon when something is wrong. */
export function errorIconUri(lines: string[]): string {
  const shown = lines.slice(0, 2).map((l) => l.slice(0, 12));
  const size = (text: string, base: number) => Math.max(14, Math.min(base, Math.floor(120 / Math.max(text.length * 0.62, 1))));
  let body: string;
  if (shown.length === 2) {
    body =
      `<text x="72" y="64" font-size="${size(shown[0], 26)}">${xml(shown[0])}</text>` +
      `<text x="72" y="116" font-size="${size(shown[1], 54)}">${xml(shown[1])}</text>`;
  } else {
    body = `<text x="72" y="92" font-size="${size(shown[0] ?? "ERR", 34)}">${xml(shown[0] ?? "ERR")}</text>`;
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
    `<rect x="3" y="3" width="138" height="138" rx="20" fill="#7f1d1d" stroke="#ef4444" stroke-width="6"/>` +
    `<g fill="#fff" font-family="sans-serif" font-weight="bold" text-anchor="middle">${body}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
