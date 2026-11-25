import { describe, expect, it } from "vitest";
import { errorIconUri, MAX_RASTER_BYTES, MAX_SVG_BYTES, toIconDataUri } from "../src/image";

// @types/node 20.15 and TypeScript 5.9 disagree about Buffer being a Uint8Array; this keeps the tests type-checking.
const concat = (parts: Buffer[]) => Buffer.concat(parts as unknown as Uint8Array[]);
const b64 = (s: string | Buffer) => Buffer.from(s as string).toString("base64");
/** Decode the SVG inside a result data URI. */
function svgOf(uri: string | undefined): string {
  expect(uri).toMatch(/^data:image\/svg\+xml;base64,/);
  return Buffer.from(uri!.split(",")[1], "base64").toString("utf8");
}
const svg = (inner: string, attrs = "") => `<svg viewBox="0 0 24 24"${attrs}>${inner}</svg>`;

const PNG = concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(20, 1)]);
const JPEG = concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 2)]);
const GIF = concat([Buffer.from("GIF89a"), Buffer.alloc(20, 3)]);
const WEBP = concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(20, 4)]);

describe("SVG acceptance", () => {
  it("accepts raw SVG and adds the namespace", () => {
    const out = svgOf(toIconDataUri(svg('<path d="M0 0h24v24H0z"/>')));
    expect(out).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox');
    expect(out).toContain('<path d="M0 0h24v24H0z"/>');
  });
  it("keeps an existing namespace", () => {
    const out = svgOf(toIconDataUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'));
    expect(out.match(/xmlns=/g)).toHaveLength(1);
  });
  it("accepts an Iconoir-style icon unchanged", () => {
    const icon =
      '<svg width="24" height="24" stroke-width="1.5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" color="currentColor">' +
      '<path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M12 6V12L16 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    expect(svgOf(toIconDataUri(icon))).toBe(icon);
  });
  it("keeps gradients and url(#id) references, quoted or not", () => {
    for (const ref of ["url(#g)", "url('#g')", 'url("#g")', "url( #g )"]) {
      const s = `<svg viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect fill="${ref.replace(/"/g, "&quot;")}" width="1" height="1"/></svg>`;
      expect(svgOf(toIconDataUri(s))).toContain(ref.replace(/"/g, "&quot;"));
    }
  });
  it("keeps in-document href / xlink:href and style with url(#id)", () => {
    const s = svg('<defs><path id="p" d="M0 0"/></defs><use href="#p"/><use xlink:href="#p"/><rect style="fill:url(#g);stroke:red"/>');
    const out = svgOf(toIconDataUri(s));
    expect(out).toContain('href="#p"');
    expect(out).toContain('xlink:href="#p"');
    expect(out).toContain("fill:url(#g)");
  });
  it("keeps an embedded raster image", () => {
    const href = `data:image/png;base64,${b64(PNG)}`;
    expect(svgOf(toIconDataUri(svg(`<image href="${href}" width="1" height="1"/>`)))).toContain(href);
  });
  it("keeps harmless <style> and text with an apostrophe or entities", () => {
    const s = svg('<style>.a{fill:red}</style><text>Tom &amp; Jerry&#39;s</text>');
    expect(svgOf(toIconDataUri(s))).toContain("Tom &amp; Jerry&#39;s");
  });
  it("drops an XML prolog, DOCTYPE and comments before the root", () => {
    const s = `<?xml version="1.0"?>\n<!-- hi -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${svg("<g/>")}`;
    expect(svgOf(toIconDataUri(s))).toMatch(/^<svg /);
  });
  it("accepts SVG as a base64 data URI, a percent-encoded one, and bare base64", () => {
    const s = svg('<circle r="1"/>');
    expect(svgOf(toIconDataUri(`data:image/svg+xml;base64,${b64(s)}`))).toContain("<circle");
    expect(svgOf(toIconDataUri(`data:image/svg+xml;utf8,${encodeURIComponent(s)}`))).toContain("<circle");
    expect(svgOf(toIconDataUri(`data:image/svg+xml,${s.replace(/</g, "%3C").replace(/>/g, "%3E")}`))).toContain("<circle");
    expect(svgOf(toIconDataUri(b64(`<?xml version="1.0"?>${s}`)))).toContain("<circle");
    expect(svgOf(toIconDataUri(b64(s)))).toContain("<circle");
  });
  it("leaves a literal % alone in an unencoded data URI", () => {
    const out = svgOf(toIconDataUri('data:image/svg+xml,<svg viewBox="0 0 1 1"><rect width="100%" height="50%"/></svg>'));
    expect(out).toContain('width="100%"');
  });
  it("trims surrounding whitespace", () => {
    expect(toIconDataUri(`  \n${svg("<g/>")}\n `)).toBeDefined();
  });
});

describe("SVG rejection and stripping", () => {
  it.each([
    ["script", "<script>alert(1)</script>"],
    ["SCRIPT upper", "<SCRIPT>x</SCRIPT>"],
    ["prefixed script", '<svg:script xmlns:svg="http://www.w3.org/2000/svg">x</svg:script>'],
    ["foreignObject", "<foreignObject><div/></foreignObject>"],
    ["iframe", "<iframe src='x'/>"],
    ["object", "<object data='x'/>"],
    ["embed", "<embed src='x'/>"],
    ["audio", "<audio/>"],
    ["video", "<video/>"],
    ["animate", '<animate attributeName="href" values="x"/>'],
    ["animateTransform", "<animateTransform/>"],
    ["animateMotion", "<animateMotion/>"],
    ["set", '<set attributeName="href" to="x"/>'],
    ["handler", "<handler/>"],
    ["entity declaration", "<!ENTITY x 'y'>"],
    ["whitespace before tag name", "< script>x</script>"],
  ])("rejects %s", (_n, inner) => {
    expect(toIconDataUri(svg(inner))).toBeUndefined();
  });

  it("rejects a DOCTYPE with an internal subset", () => {
    expect(toIconDataUri(`<!DOCTYPE svg [<!ENTITY a "b">]>${svg("<g/>")}`)).toBeUndefined();
  });
  it("rejects non-SVG input", () => {
    expect(toIconDataUri("<html></html>")).toBeUndefined();
    expect(toIconDataUri("<svgx/>")).toBeUndefined();
    expect(toIconDataUri("hello")).toBeUndefined();
    expect(toIconDataUri("")).toBeUndefined();
    expect(toIconDataUri("   ")).toBeUndefined();
    expect(toIconDataUri("data:text/html,<svg/>")).toBeUndefined();
    expect(toIconDataUri("https://example.com/a.svg")).toBeUndefined();
  });

  it("strips event handler attributes", () => {
    const out = svgOf(toIconDataUri(svg("<rect onclick=\"x()\" width='1' onmouseover='y()' onload=z() />", ' onload="a()"')));
    expect(out).not.toMatch(/\bon[a-z]+\s*=/i);
    expect(out).toContain('width=\'1\'');
  });
  it("strips handlers behind a namespace prefix or a slash", () => {
    expect(svgOf(toIconDataUri('<svg viewBox="0 0 1 1" xmlns:x="u" x:onload="a()"/>'))).not.toMatch(/onload/);
    expect(svgOf(toIconDataUri('<svg viewBox="0 0 1 1"><rect/onload="a()" width="1"/></svg>'))).not.toMatch(/onload/);
    expect(toIconDataUri('<svg/onload="a()" viewBox="0 0 1 1"/>')).toBeUndefined(); // not well-formed: refused outright
  });
  it("strips external and javascript hrefs, any quoting, any prefix", () => {
    for (const h of [
      'href="https://evil.example/x"',
      "href='http://evil.example/x'",
      'xlink:href="//evil.example/x"',
      "href=http://evil.example/x",
      'href="javascript:alert(1)"',
      'a:href="file:///etc/passwd"',
      'href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="',
      'href="data:image/png,<svg onload=alert(1)>"',
      'href=" java&#x09;script:alert(1)"',
    ]) {
      const out = svgOf(toIconDataUri(`<svg viewBox="0 0 1 1" xmlns:a="u" xmlns:xlink="http://www.w3.org/1999/xlink"><use ${h}/></svg>`));
      expect(out, h).not.toMatch(/href/);
    }
  });
  it("neutralises CSS url() to external targets and @import", () => {
    const out = svgOf(
      toIconDataUri(
        svg('<style>@import url(http://evil/x.css); .a{fill:url(http://evil/p)}</style><rect style="background:url(\'https://evil/x\')" fill="url(data:image/png;base64,AAAA)"/>'),
      ),
    );
    expect(out).not.toContain("evil");
    expect(out).not.toMatch(/@import/);
    expect(out).not.toMatch(/url\(\s*['"]?(?!#)/);
  });
  it("does not rewrite url() inside text-like harmless content", () => {
    expect(toIconDataUri(svg("<text>no fetch here</text>"))).toBeDefined();
  });
});

describe("SVG filter: encoded and escaped bypass attempts", () => {
  const wrap = (attr: string) => svg(`<rect ${attr}/>`);
  it.each([
    ["numeric entity in url(", 'style="fill:&#117;rl(http://evil/x)"'],
    ["hex entity in url(", 'style="fill:&#x75;rl(http://evil/x)"'],
    ["entity without semicolon", 'style="fill:&#117rl(http://evil/x)"'],
    ["entity for the paren", 'style="fill:url&#40;http://evil/x)"'],
    ["named entity for the paren", 'style="fill:url&lpar;http://evil/x)"'],
    ["CSS escape in url(", 'style="fill:\\75 rl(http://evil/x)"'],
    ["long CSS escape", 'style="fill:\\000075rl(http://evil/x)"'],
    ["CSS escape of l", 'style="fill:ur\\6c(http://evil/x)"'],
    ["escaped single char", 'style="fill:\\u\\r\\l(http://evil/x)"'],
    ["entity-encoded backslash escape", 'style="fill:&#92;75 rl(http://evil/x)"'],
    ["entity-encoded backslash named", 'style="fill:&bsol;75 rl(http://evil/x)"'],
    ["presentation attribute with entity", 'fill="&#117;rl(http://evil/x)"'],
    ["presentation attribute with CSS escape", 'fill="\\75 rl(http://evil/x)"'],
    ["image-set", 'style="background:image-set(\'http://evil/x\' 1x)"'],
    ["escaped image-set", 'style="background:\\69mage-set(\'http://evil/x\' 1x)"'],
    ["src()", 'style="background:src(\'http://evil/x\')"'],
    ["escaped @import in style attr", 'style="@\\69mport \'http://evil/x\'"'],
    ["entity @import in style attr", 'style="&#64;import \'http://evil/x\'"'],
    ["javascript: in an attribute", 'title="&#106;avascript:alert(1)"'],
  ])("rejects %s", (_n, attr) => {
    expect(toIconDataUri(wrap(attr))).toBeUndefined();
  });

  it("neutralises a url() split by a CSS comment", () => {
    const out = svgOf(toIconDataUri(wrap('style="fill:/**/url(http://evil/x)"')));
    expect(out).not.toContain("evil");
  });

  it("stays fast on pathological input (no regex blow-up)", () => {
    const n = MAX_SVG_BYTES - 100;
    const t0 = Date.now();
    for (const inner of ["a".repeat(n), "a ".repeat(n / 2), "/".repeat(n), "<".repeat(n), "=".repeat(n), " href".repeat(n / 5), "<style>".repeat(n / 7), "url(".repeat(n / 4), "&#".repeat(n / 2), "\\".repeat(n)]) {
      toIconDataUri(`<svg viewBox="0 0 1 1"><g a="${inner}"/>${inner}</svg>`);
    }
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it("rejects obfuscated @import and url() in a <style> element", () => {
    expect(toIconDataUri(svg("<style>@\\69mport 'http://evil/x';</style>"))).toBeUndefined();
    expect(toIconDataUri(svg("<style>@&#105;mport 'http://evil/x';</style>"))).toBeUndefined();
    expect(toIconDataUri(svg("<style>.a{fill:\\75 rl(http://evil/x)}</style>"))).toBeUndefined();
    expect(toIconDataUri(svg("<style>.a{fill:&#117;rl(http://evil/x)}</style>"))).toBeUndefined();
    expect(toIconDataUri(svg("<style type='text/css'>.a{fill:\\75rl(http://evil/x)}</style>"))).toBeUndefined();
    expect(toIconDataUri(svg("<svg:style xmlns:svg='u'>@\\69mport 'x';</svg:style>"))).toBeUndefined();
    expect(toIconDataUri(svg("<style><![CDATA[@\\69mport 'x';]]></style>"))).toBeUndefined();
  });

  it("entity-obfuscated hrefs that decode to something allowed are judged by what they decode to", () => {
    // decodes to "#p": fine, stays; decodes to a web URL: stripped
    expect(svgOf(toIconDataUri(svg('<use href="&#35;p"/>')))).toContain('href="&#35;p"');
    expect(svgOf(toIconDataUri(svg('<use href="&#104;ttp://evil/x"/>')))).not.toMatch(/href/);
    expect(svgOf(toIconDataUri(svg('<use href="&#x68;ttps&colon;//evil/x"/>')))).not.toMatch(/href/);
  });

  it("still accepts escapes and entities that do not hide anything", () => {
    expect(toIconDataUri(svg('<text font-family="Arial, \\"Helvetica\\"">caf&#233; &#x1F600;</text>'))).toBeDefined();
    expect(toIconDataUri(svg('<rect style="fill:\\72 ed"/>'))).toBeDefined();
    expect(toIconDataUri(svg('<title>a &amp; b</title><rect fill="url(&#35;g)"/>'.replace("&#35;", "#")))).toBeDefined();
  });
});

describe("SVG size limit", () => {
  it("accepts just under and rejects over MAX_SVG_BYTES", () => {
    const pad = (n: number) => `<svg viewBox="0 0 1 1"><!--${"a".repeat(n)}--><g/></svg>`;
    const base = Buffer.byteLength(pad(0));
    expect(toIconDataUri(pad(MAX_SVG_BYTES - base))).toBeDefined();
    expect(toIconDataUri(pad(MAX_SVG_BYTES - base + 1))).toBeUndefined();
  });
  it("counts bytes of the decoded data URI, not characters", () => {
    const wide = `<svg viewBox="0 0 1 1"><text>${"é".repeat(MAX_SVG_BYTES / 2)}</text></svg>`;
    expect(toIconDataUri(`data:image/svg+xml;base64,${b64(wide)}`)).toBeUndefined();
  });
});

describe("raster images", () => {
  const cases: [string, Buffer, string][] = [
    ["png", PNG, "png"],
    ["jpeg", JPEG, "jpeg"],
    ["gif", GIF, "gif"],
    ["webp", WEBP, "webp"],
  ];
  it.each(cases)("sniffs %s from a data URI", (_n, buf, type) => {
    expect(toIconDataUri(`data:image/${type};base64,${b64(buf)}`)).toBe(`data:image/${type};base64,${b64(buf)}`);
  });
  it.each(cases)("sniffs %s from bare base64", (_n, buf, type) => {
    expect(toIconDataUri(b64(buf))).toBe(`data:image/${type};base64,${b64(buf)}`);
  });
  it("takes the type from the header, not the claimed MIME type", () => {
    expect(toIconDataUri(`data:image/gif;base64,${b64(PNG)}`)).toBe(`data:image/png;base64,${b64(PNG)}`);
    expect(toIconDataUri(`data:image/jpg;base64,${b64(JPEG)}`)).toBe(`data:image/jpeg;base64,${b64(JPEG)}`);
  });
  it("accepts GIF87a, parameters in the MIME type, whitespace and base64url", () => {
    const g87 = concat([Buffer.from("GIF87a"), Buffer.alloc(8)]);
    expect(toIconDataUri(b64(g87))).toMatch(/^data:image\/gif/);
    expect(toIconDataUri(`data:image/png;charset=x;base64,${b64(PNG)}`)).toBeDefined();
    expect(toIconDataUri(`data:image/png;base64,${b64(PNG).replace(/(.{8})/g, "$1\n")}`)).toBe(`data:image/png;base64,${b64(PNG)}`);
    const url = Buffer.from([0xff, 0xd8, 0xff, 0xfb, 0xfe, 0xff, 0xfa, 0xfb, 0xfc, 0xfd]);
    expect(toIconDataUri(b64(url).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))).toMatch(/^data:image\/jpeg/);
  });
  it("rejects data that is not an image", () => {
    expect(toIconDataUri(`data:image/png;base64,${b64("hello world, this is text")}`)).toBeUndefined();
    expect(toIconDataUri(`data:image/png;base64,${b64(Buffer.from("89504e47", "hex"))}`)).toBeUndefined(); // truncated header
    expect(toIconDataUri(`data:image/png;base64,!!!notbase64!!!`)).toBeUndefined();
    expect(toIconDataUri("data:image/png;base64,")).toBeUndefined();
    expect(toIconDataUri("data:image/png,rawbytes")).toBeUndefined();
    expect(toIconDataUri("data:image/bmp;base64,Qk0=")).toBeUndefined();
  });
  it("rejects a RIFF file that is not WebP", () => {
    const wav = concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(20)]);
    expect(toIconDataUri(b64(wav))).toBeUndefined();
  });
  it("enforces MAX_RASTER_BYTES", () => {
    const ok = concat([PNG, Buffer.alloc(MAX_RASTER_BYTES - PNG.length)]);
    const big = concat([ok, Buffer.alloc(1)]);
    expect(toIconDataUri(`data:image/png;base64,${b64(ok)}`)).toBeDefined();
    expect(toIconDataUri(`data:image/png;base64,${b64(big)}`)).toBeUndefined();
    expect(toIconDataUri(`data:image/png;base64,${b64(concat([PNG, Buffer.alloc(MAX_RASTER_BYTES * 2)]))}`)).toBeUndefined();
  });
  it("does not let SVG hide behind a raster MIME type", () => {
    expect(toIconDataUri(`data:image/png;base64,${b64(svg("<g/>"))}`)).toBeUndefined();
  });
});

describe("errorIconUri", () => {
  it("builds a red SVG tile with escaped text", () => {
    const out = svgOf(errorIconUri(["HTTP", "404"]));
    expect(out).toContain("HTTP");
    expect(out).toContain("404");
    expect(out).toContain("#7f1d1d");
  });
  it("handles one line, no lines, and more than two", () => {
    expect(svgOf(errorIconUri(["TIMEOUT"])).match(/<text/g)).toHaveLength(1);
    expect(svgOf(errorIconUri([]))).toContain("ERR");
    expect(svgOf(errorIconUri(["a", "b", "c"])).match(/<text/g)).toHaveLength(2);
  });
  it("escapes markup and truncates to 12 characters", () => {
    const out = svgOf(errorIconUri(['<b>&"\'', "x".repeat(40)]));
    expect(out).toContain("&lt;b&gt;&amp;&quot;&apos;");
    expect(out).not.toContain("x".repeat(13));
  });
  it("passes our own SVG filter", () => {
    const uri = errorIconUri(["BAD", "ICON"]);
    expect(toIconDataUri(uri)).toBeDefined();
  });
});

