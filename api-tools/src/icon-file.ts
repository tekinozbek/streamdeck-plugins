/**
 * Loads an icon the user points at on disk (for the API Toggle's per-state icons) as a safe data URI.
 *
 * Only absolute local paths to .svg/.png/.jpg/.jpeg/.gif/.webp files are read. UNC / network paths are refused
 * (opening one makes Windows send credentials to that host), and the content goes through the same filter as
 * icons from an API, so a path to some other kind of file never reaches the key.
 */

import fs from "node:fs";
import path from "node:path";
import { MAX_RASTER_BYTES, MAX_SVG_BYTES, toIconDataUri } from "./image";

export type IconFileResult = { uri: string } | { error: string };

const EXT = new Set([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);

// Two leading separators of either kind: \\server, //server, /\server, and device paths such as \\?\.
const NETWORK = /^[\\/]{2}/;

/** Check the text of a path without touching the file system: merely looking at a network path contacts the host. */
function localPath(raw: string): { path: string } | { error: string } {
  // Paths are often pasted with quotes ("Copy as path").
  const p = raw.trim().replace(/^"(.*)"$/, "$1").trim();
  if (!p) return { error: "no file path set" };
  const network = { error: "network paths are not allowed; use a local file" };
  if (NETWORK.test(p)) return network;
  if (!path.isAbsolute(p)) return { error: "use the full path, e.g. C:\\icons\\on.svg or /Users/you/icons/on.svg" };
  const resolved = path.resolve(p);
  if (NETWORK.test(resolved)) return network;
  if (!EXT.has(path.extname(resolved).toLowerCase())) return { error: "file must be .svg, .png, .jpg, .gif or .webp" };
  return { path: resolved };
}

export function readIconFile(raw: string): IconFileResult {
  const checked = localPath(raw);
  if ("error" in checked) return checked;
  const p = checked.path;
  const ext = path.extname(p).toLowerCase();

  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { error: "not a file" };
    const svg = ext === ".svg";
    if (st.size > (svg ? MAX_SVG_BYTES : MAX_RASTER_BYTES)) return { error: `file is too large (max ${svg ? "256" : "512"} KB)` };
    const buf = fs.readFileSync(p);
    const uri = toIconDataUri(svg ? buf.toString("utf8") : buf.toString("base64"));
    return uri ? { uri } : { error: "not a usable image (or the SVG has blocked content)" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { error: code === "ENOENT" ? "file not found" : `cannot read file (${code ?? "error"})` };
  }
}

/** Re-reads a file only when its size or modified time changed, so polling every 250 ms doesn't hit the disk. */
export class IconFileCache {
  private entries = new Map<string, { sig: string; result: IconFileResult }>();

  get(raw: string): IconFileResult {
    const checked = localPath(raw);
    if ("error" in checked) return checked; // never reaches the file system

    let sig = "missing";
    try {
      const st = fs.statSync(checked.path);
      sig = `${st.size}:${st.mtimeMs}`;
    } catch {
      // fall through: readIconFile reports why
    }
    const hit = this.entries.get(raw);
    if (hit && hit.sig === sig) return hit.result;
    const result = readIconFile(raw);
    if (this.entries.size >= 8) this.entries.clear(); // bounded
    this.entries.set(raw, { sig, result });
    return result;
  }
}
