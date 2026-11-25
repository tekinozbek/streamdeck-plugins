/** Inputs that used to be slow, slip through, or leak into the log. */
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { evaluate } from "../src/expr";
import { describeError } from "../src/http";
import { IconFileCache, readIconFile } from "../src/icon-file";
import { MAX_SVG_BYTES, toIconDataUri } from "../src/image";

/** The linear versions take milliseconds; the quadratic ones took over a second. */
const FAST_MS = 500;
function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}
const filled = (unit: string) => unit.repeat(Math.floor((MAX_SVG_BYTES - 100) / unit.length));

describe("long inputs stay fast", () => {
  it("a long run of digits followed by something else", () => {
    const v = "1".repeat(1_000_000) + "x";
    expect(timed(() => evaluate("={v} * 2", { v }))).toBeLessThan(FAST_MS);
  });

  it.each([
    ["unclosed url(", `<svg>${filled("url(")}</svg>`],
    ["unclosed CSS comments", `<svg a="${filled("/*a")}"/>`],
    ["unclosed <style> tags", `<svg>${filled("<style>")}</svg>`],
    ["spaces inside url(", `<svg a="url(${filled(" ")}#x)"/>`],
  ])("SVG with %s", (_name, svg) => {
    expect(timed(() => toIconDataUri(svg))).toBeLessThan(FAST_MS);
  });
});

describe("numbers too large to round", () => {
  it("are left as they are", () => {
    expect(evaluate("=round(1e21, 2)", {})).toBe("1e+21");
    expect(evaluate("=fixed(1e21, 2)", {})).toBe("1e+21");
  });
});

describe("SVG filter", () => {
  const decoded = (uri: string | undefined) => uri && Buffer.from(uri.split(",")[1], "base64").toString("utf8");

  it("handles namespace prefixes with non-ASCII letters", () => {
    expect(toIconDataUri("<svg><ä:script>1</ä:script></svg>")).toBeUndefined();
    expect(toIconDataUri("<svg><ä:style>a{b:&#117;rl(http://x)}</ä:style></svg>")).toBeUndefined();
    expect(decoded(toIconDataUri('<svg><image ä:href="file:///c:/a.png"/></svg>'))).not.toContain("file:");
  });
  it("allows many plain <use> elements, as charts and glyph text have", () => {
    const glyphs = '<defs><path id="a" d="M0 0h1"/><path id="b" d="M0 0h2"/></defs>';
    const body = '<use href="#a"/><use xlink:href="#b" x="1"/>'.repeat(1500);
    expect(toIconDataUri(`<svg xmlns:xlink="http://www.w3.org/1999/xlink">${glyphs}${body}</svg>`)).toBeDefined();
  });
  it("refuses <use> that multiplies through nesting, in few elements", () => {
    let defs = '<path id="g0" d="M0 0h1"/>';
    for (let i = 1; i <= 30; i++) defs += `<g id="g${i}"><use href="#g${i - 1}"/><use href="&#35;g${i - 1}"/></g>`;
    expect(timed(() => expect(toIconDataUri(`<svg><defs>${defs}</defs><use href="#g30"/></svg>`)).toBeUndefined())).toBeLessThan(FAST_MS);
  });
  it("refuses <use> loops and absurd nesting", () => {
    expect(toIconDataUri('<svg><g id="a"><use href="#a"/></g></svg>')).toBeUndefined();
    expect(toIconDataUri('<svg><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></svg>')).toBeUndefined();
    expect(toIconDataUri(`<svg>${"<g>".repeat(5000)}<use href="#x"/></svg>`)).toBeUndefined();
  });
  it("still allows in-document url() references, however they are spaced", () => {
    expect(toIconDataUri('<svg><path fill="url( \'#g\' )"/></svg>')).toBeDefined();
    expect(toIconDataUri('<svg><path fill=\'url( "#g" )\'/></svg>')).toBeDefined();
  });
  it.each([
    ["a big <use> document", `<svg>${filled('<use href="#a"/>')}</svg>`],
    ["unclosed tags beside a <use>", `<svg><use/>${filled("<a ")}</svg>`],
    ["long attribute names beside a <use>", `<svg><use ${filled("a")}/></svg>`],
    ["unmatched closing tags beside a <use>", `<svg><use/>${filled("</q>")}</svg>`],
  ])("stays fast on %s", (_name, svg) => {
    expect(timed(() => toIconDataUri(svg))).toBeLessThan(FAST_MS);
  });
  it("stays fast on a huge percent-encoded data URI", () => {
    for (const size of [100_000, 1_000_000]) {
      expect(timed(() => toIconDataUri("data:image/svg+xml," + "%C3".repeat(size / 3)))).toBeLessThan(FAST_MS);
    }
  });
});

describe("network paths for icon files", () => {
  const paths = ["\\\\host\\share\\x.png", "//host/share/x.png", "/\\host\\share\\x.png", "\\/host/share/x.png", '"\\\\?\\UNC\\host\\x.png"'];

  it.each(paths)("%s is refused without touching the file system", (p) => {
    const stat = vi.spyOn(fs, "statSync");
    const read = vi.spyOn(fs, "readFileSync");
    try {
      for (const result of [readIconFile(p), new IconFileCache().get(p)]) {
        expect(result).toEqual({ error: expect.stringMatching(/network/) });
      }
      expect(stat).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      stat.mockRestore();
      read.mockRestore();
    }
  });
});

describe("log messages", () => {
  const failure = async (url: string, headers: Record<string, string> = {}) => {
    try {
      await fetch(url, { headers });
    } catch (err) {
      return describeError(err);
    }
    throw new Error("expected the request to fail");
  };

  it("don't repeat a URL that has no scheme", async () => {
    const message = await failure("example.invalid/api?token=SECRET123");
    expect(message).toMatch(/invalid URL/);
    expect(message).not.toContain("SECRET123");
  });
  it("don't repeat a bad header", async () => {
    for (const headers of [{ "X-Key": "SECRET123\u0000" }, { "Authorization Bearer SECRET123": "x" }] as Record<string, string>[]) {
      expect(await failure("http://127.0.0.1:1/", headers)).not.toContain("SECRET123");
    }
  });
  it("don't repeat credentials written into the URL", async () => {
    expect(await failure("http://user:SECRET123@127.0.0.1:1/")).not.toContain("SECRET123");
  });
});
