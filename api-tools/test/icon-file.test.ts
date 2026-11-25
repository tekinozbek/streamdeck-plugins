import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_RASTER_BYTES, MAX_SVG_BYTES } from "../src/image";
import { IconFileCache, readIconFile } from "../src/icon-file";

// @types/node 20.15 and TypeScript 5.9 disagree about Buffer being a Uint8Array; this keeps the tests type-checking.
const concat = (parts: Buffer[]) => Buffer.concat(parts as unknown as Uint8Array[]);
const PNG = concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(20, 1)]);
const SVG = '<svg viewBox="0 0 24 24"><path d="M1 1L5 5" stroke="white"/></svg>';

let dir: string;
const file = (name: string, data: string | Buffer) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, data as string);
  return p;
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-file-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("readIconFile", () => {
  it("loads an SVG and a PNG as data URIs", () => {
    const svg = readIconFile(file("a.svg", SVG));
    expect("uri" in svg && svg.uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const png = readIconFile(file("a.png", PNG));
    expect("uri" in png && png.uri.startsWith("data:image/png;base64,")).toBe(true);
  });
  it("accepts a quoted path (as pasted by 'Copy as path') and is case-insensitive about the extension", () => {
    expect(readIconFile(`"${file("b.PNG", PNG)}"`)).toHaveProperty("uri");
  });
  it("refuses relative paths", () => {
    expect(readIconFile("icons/on.svg")).toHaveProperty("error");
    expect(readIconFile("on.svg")).toHaveProperty("error");
  });
  it("refuses network (UNC) paths without touching them", () => {
    expect(readIconFile("\\\\evil.example\\share\\x.svg")).toEqual({ error: expect.stringMatching(/network/) });
    expect(readIconFile("//evil.example/share/x.svg")).toEqual({ error: expect.stringMatching(/network/) });
  });
  it("refuses files that aren't image types", () => {
    expect(readIconFile(file("secret.txt", "hello"))).toEqual({ error: expect.stringMatching(/must be/) });
    expect(readIconFile(file("x.json", "{}"))).toHaveProperty("error");
  });
  it("refuses a non-image disguised with an image extension", () => {
    expect(readIconFile(file("fake.png", "just some text, not a png"))).toEqual({ error: expect.stringMatching(/not a usable image/) });
  });
  it("refuses an SVG with blocked content", () => {
    expect(readIconFile(file("bad.svg", '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>'))).toHaveProperty("error");
  });
  it("refuses oversized files", () => {
    expect(readIconFile(file("big.svg", SVG + " ".repeat(MAX_SVG_BYTES)))).toEqual({ error: expect.stringMatching(/too large/) });
    expect(readIconFile(file("big.png", concat([PNG, Buffer.alloc(MAX_RASTER_BYTES)])))).toEqual({ error: expect.stringMatching(/too large/) });
  });
  it("reports missing files, directories and empty input", () => {
    expect(readIconFile(path.join(dir, "nope.svg"))).toEqual({ error: "file not found" });
    fs.mkdirSync(path.join(dir, "folder.svg"));
    expect(readIconFile(path.join(dir, "folder.svg"))).toEqual({ error: "not a file" });
    expect(readIconFile("  ")).toHaveProperty("error");
  });
});

describe("IconFileCache", () => {
  it("returns the same result until the file changes", () => {
    const p = file("c.svg", SVG);
    const cache = new IconFileCache();
    const first = cache.get(p);
    expect(cache.get(p)).toBe(first); // cached object, no re-read
    fs.writeFileSync(p, SVG.replace("white", "red"));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(p, future, future);
    const changed = cache.get(p);
    expect(changed).not.toBe(first);
    expect(changed).not.toEqual(first);
  });
  it("notices a file that appears later", () => {
    const p = path.join(dir, "later.svg");
    const cache = new IconFileCache();
    expect(cache.get(p)).toEqual({ error: "file not found" });
    fs.writeFileSync(p, SVG);
    expect(cache.get(p)).toHaveProperty("uri");
  });
});
