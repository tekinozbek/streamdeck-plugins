import { describe, expect, it } from "vitest";
import { evaluate, evaluateUrl, extract } from "../src/expr";

const data = {
  name: "Stream Deck",
  n: 7,
  f: 2.25,
  s: "12",
  neg: -5,
  t: "0930",
  on: true,
  nul: null,
  obj: { a: 1, b: [1, 2] },
  items: [{ count: 3 }, { count: 4 }],
  time: { hour: 9, minute: 5 },
  url: "https://example.com/a?b=c d",
  emoji: "a\u{1F600}b",
  "weird key": 1,
};

describe("extract", () => {
  it("resolves dotted paths and indexes", () => {
    expect(extract(data, "obj.a")).toBe(1);
    expect(extract(data, "items[1].count")).toBe(4);
    expect(extract(data, "items.0.count")).toBe(3);
    expect(extract(data, "obj.b[1]")).toBe(2);
  });
  it("returns undefined for missing paths and through null", () => {
    expect(extract(data, "nope")).toBeUndefined();
    expect(extract(data, "nul.x")).toBeUndefined();
    expect(extract(data, "items[9].count")).toBeUndefined();
    expect(extract(undefined, "a")).toBeUndefined();
  });
  it("does not reach into the prototype", () => {
    expect(extract(data, "constructor")).toBeUndefined();
    expect(extract(data, "__proto__")).toBeUndefined();
    expect(extract(data, "toString")).toBeUndefined();
  });
  it("returns the root for an empty path", () => {
    expect(extract(data, "")).toBe(data);
  });
});

describe("evaluate: plain paths", () => {
  it("formats values", () => {
    expect(evaluate("name", data)).toBe("Stream Deck");
    expect(evaluate("n", data)).toBe("7");
    expect(evaluate("on", data)).toBe("true");
    expect(evaluate("obj", data)).toBe('{"a":1,"b":[1,2]}');
    expect(evaluate("items[0].count", data)).toBe("3");
  });
  it("shows n/a for missing and null", () => {
    expect(evaluate("missing", data)).toBe("n/a");
    expect(evaluate("nul", data)).toBe("n/a");
  });
  it("trims the expression", () => {
    expect(evaluate("  n  ", data)).toBe("7");
  });
  it("shows n/a for non-finite numbers", () => {
    expect(evaluate("x", { x: 1e999 })).toBe("n/a");
  });
});

describe("evaluate: templates", () => {
  it("fills {path} blocks", () => {
    expect(evaluate("{name}: {n}", data)).toBe("Stream Deck: 7");
  });
  it("keeps literal text and prints n/a for missing values", () => {
    expect(evaluate("T={missing}!", data)).toBe("T=n/a!");
  });
  it("supports functions inside blocks", () => {
    expect(evaluate("{time.hour}:{pad({time.minute}, 2)}", data)).toBe("9:05");
  });
  it("function with a missing value still renders n/a in display mode", () => {
    expect(evaluate("{pad({missing}, 2)}", data)).toBe("n/a".padStart(2, "0"));
  });
  it("handles quotes containing braces", () => {
    expect(evaluate("{pad(1, 3, '}')}", data)).toBe("}}1");
  });
  it("reports an unterminated block", () => {
    expect(() => evaluate("{name", data)).toThrow("Missing }");
  });
  it("applies a slice suffix after a block", () => {
    expect(evaluate("{name}[0:6]", data)).toBe("Stream");
    expect(evaluate("{name}[-4:]", data)).toBe("Deck");
    expect(evaluate("{name}[:-1]", data)).toBe("Stream Dec");
    expect(evaluate("{name}[-1]", data)).toBe("k");
    expect(evaluate("{name}[::2]", data)).toBe("Sra ek");
    expect(evaluate("{name}[::-1]", data)).toBe("kceD maertS");
  });
  it("leaves a non-slice [..] suffix alone", () => {
    expect(evaluate("{n}[abc]", data)).toBe("7[abc]");
    expect(evaluate("{n}[]", data)).toBe("7[]");
  });
});

describe("evaluate: maths", () => {
  const m = (e: string) => evaluate(e, data);
  it("does arithmetic and precedence", () => {
    expect(m("=1 + 2 * 3")).toBe("7");
    expect(m("=(1 + 2) * 3")).toBe("9");
    expect(m("=10 / 4")).toBe("2.5");
    expect(m("=10 % 4")).toBe("2");
    expect(m("=2 - 5")).toBe("-3");
    expect(m("=-3 + 1")).toBe("-2");
    expect(m("=--3")).toBe("3");
  });
  it("removes float noise from computed results only", () => {
    expect(m("=0.1 + 0.2")).toBe("0.3");
    expect(m("{f}")).toBe("2.25");
  });
  it("reads values and converts numeric text", () => {
    expect(m("={n} * 2")).toBe("14");
    expect(m("={s} + 1")).toBe("13");
    expect(m("={t}[0:2] * 60")).toBe("540");
  });
  it("adds numeric text but concatenates other text", () => {
    expect(m('="1" + "2"')).toBe("3");
    expect(m('="a" + "b"')).toBe("ab");
    expect(m('="a" + 1')).toBe("a1");
  });
  it("gives n/a for missing operands and bad arithmetic", () => {
    expect(m("={missing} + 1")).toBe("n/a");
    expect(m("={missing} * 2")).toBe("n/a");
    expect(m("=1 / 0")).toBe("n/a");
    expect(m('="x" * 2')).toBe("n/a");
  });
  it("supports exponents and decimals in literals", () => {
    expect(m("=1e3 + .5")).toBe("1000.5");
  });
  it("supports string literals with either quote", () => {
    expect(m("='hi'")).toBe("hi");
    expect(m('="hi"')).toBe("hi");
  });
  it("slices values inside maths", () => {
    expect(m('="hello"[1:3]')).toBe("el");
    expect(m("={name}[0]")).toBe("S");
    expect(m("={missing}[0]")).toBe("n/a");
  });
});

describe("evaluate: slices", () => {
  const s = (spec: string) => evaluate(`="abcdef"[${spec}]`, data);
  it("indexes", () => {
    expect(s("0")).toBe("a");
    expect(s("-1")).toBe("f");
    expect(s("99")).toBe("");
    expect(s("-99")).toBe("");
  });
  it("slices with defaults and clamping", () => {
    expect(s("1:3")).toBe("bc");
    expect(s(":2")).toBe("ab");
    expect(s("4:")).toBe("ef");
    expect(s(":")).toBe("abcdef");
    expect(s("-3:-1")).toBe("de");
    expect(s("2:99")).toBe("cdef");
    expect(s("-99:2")).toBe("ab");
    expect(s("3:1")).toBe("");
  });
  it("supports steps, including negative", () => {
    expect(s("::2")).toBe("ace");
    expect(s("1::2")).toBe("bdf");
    expect(s("::-1")).toBe("fedcba");
    expect(s("4:1:-1")).toBe("edc");
    expect(s("-1:-4:-1")).toBe("fed");
  });
  it("works by code point", () => {
    expect(evaluate("={emoji}[1]", data)).toBe("\u{1F600}");
    expect(evaluate("={emoji}[1:3]", data)).toBe("\u{1F600}b");
  });
  it("rejects bad specs", () => {
    expect(() => s("::0")).toThrow("zero");
    expect(() => s("")).toThrow("Bad slice");
    expect(() => s("a")).toThrow("Bad slice");
    expect(() => s("1:2:3:4")).toThrow("Bad slice");
    expect(() => s("-")).toThrow("Bad slice");
  });
  it("reports a missing ]", () => {
    expect(() => evaluate('="abc"[1', data)).toThrow("Missing ]");
  });
  it("allows whitespace in specs", () => {
    expect(s(" 1 : 3 ")).toBe("bc");
  });
});

describe("evaluate: functions", () => {
  const e = (x: string) => evaluate(`=${x}`, data);
  it("round", () => {
    expect(e("round(2.5)")).toBe("3");
    expect(e("round(-2.5)")).toBe("-3");
    expect(e("round(1.005, 2)")).toBe("1.01");
    expect(e("round(1234.5678, -2)")).toBe("1200");
    expect(e("round(2.4)")).toBe("2");
    expect(e('round("x")')).toBe("n/a");
    expect(e("round(1e25, 2)")).toBe("1e+25");
    expect(e("round(5, 100)")).toBe("5");
  });
  it("fixed", () => {
    expect(e("fixed(5, 1)")).toBe("5.0");
    expect(e("fixed(2.25, 1)")).toBe("2.3");
    expect(e("fixed(2.25)")).toBe("2.3");
    expect(e("fixed(3.14159, 3)")).toBe("3.142");
    expect(e("fixed(7, 0)")).toBe("7");
    expect(e('fixed("x", 2)')).toBe("n/a");
  });
  it("floor, ceil, abs", () => {
    expect(e("floor(2.9)")).toBe("2");
    expect(e("floor(-2.1)")).toBe("-3");
    expect(e("ceil(2.1)")).toBe("3");
    expect(e("ceil(-2.9)")).toBe("-2");
    expect(e("abs(-4)")).toBe("4");
    expect(e("abs({neg})")).toBe("5");
  });
  it("min, max", () => {
    expect(e("min(3, 1, 2)")).toBe("1");
    expect(e("max(3, 1, 2)")).toBe("3");
    expect(e("max({n}, 10)")).toBe("10");
    expect(e('max("5", 3)')).toBe("5");
    expect(e("min(1, {missing})")).toBe("n/a");
  });
  it("pad", () => {
    expect(evaluate("{pad(5, 3)}", data)).toBe("005");
    expect(evaluate("{pad({neg}, 4)}", data)).toBe("-005");
    expect(evaluate("{pad('ab', 5, '.')}", data)).toBe("...ab");
    expect(evaluate("{pad(12345, 3)}", data)).toBe("12345");
    expect(evaluate("{pad(1, 500)}", data)).toBe("1".padStart(200, "0"));
    expect(evaluate("{pad(1, -2)}", data)).toBe("1");
  });
  it("nests functions", () => {
    expect(e("round(max(1.234, 2.345), 1)")).toBe("2.3");
  });
  it("rejects unknown and prototype functions", () => {
    expect(() => e("nope(1)")).toThrow('Unknown function "nope"');
    expect(() => e("constructor(1)")).toThrow("Unknown function");
    expect(() => e("toString(1)")).toThrow("Unknown function");
    expect(() => e("hasOwnProperty(1)")).toThrow("Unknown function");
  });
  it("requires parentheses and closes them", () => {
    expect(() => e("round")).toThrow('Expected "("');
    expect(() => e("round(1")).toThrow('Expected ")"');
  });
});

describe("evaluate: errors", () => {
  it("fails on syntax errors", () => {
    expect(() => evaluate("=", data)).toThrow("Unexpected end");
    expect(() => evaluate("=1 +", data)).toThrow("Unexpected end");
    expect(() => evaluate("=(1", data)).toThrow('Expected ")"');
    expect(() => evaluate("=1 2", data)).toThrow("Unexpected");
    expect(() => evaluate("=1 )", data)).toThrow("Unexpected");
    expect(() => evaluate("=#", data)).toThrow("Unexpected");
    expect(() => evaluate("={a", data)).toThrow("Missing }");
    expect(() => evaluate('="abc', data)).toThrow("Unterminated string");
  });
});

describe("evaluateUrl", () => {
  it("percent-encodes values", () => {
    expect(evaluateUrl("https://x.com/?q={url}", data)).toBe("https://x.com/?q=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc%20d");
    expect(evaluateUrl("https://x.com/{name}", data)).toBe("https://x.com/Stream%20Deck");
  });
  it("{!path} inserts the value raw", () => {
    expect(evaluateUrl("{!url}", data)).toBe("https://example.com/a?b=c d");
    expect(evaluateUrl("{! url }", data)).toBe("https://example.com/a?b=c d");
    expect(evaluateUrl("{!pad(5, 3)}", data)).toBe("005");
  });
  it("leaves a URL without blocks untouched and trims it", () => {
    expect(evaluateUrl("  https://x.com/a?b=1  ", data)).toBe("https://x.com/a?b=1");
  });
  it("supports functions and slices", () => {
    expect(evaluateUrl("https://e.com/{pad({n}, 3)}", data)).toBe("https://e.com/007");
    expect(evaluateUrl("https://e.com/{name}[0:6]", data)).toBe("https://e.com/Stream");
  });
  it("throws for a missing or null value", () => {
    expect(() => evaluateUrl("https://x.com/{missing}", data)).toThrow("No value for {missing}");
    expect(() => evaluateUrl("https://x.com/{nul}", data)).toThrow("No value for {nul}");
    expect(() => evaluateUrl("https://x.com/{!missing}", data)).toThrow("No value for {missing}");
  });
  it("throws when a value used in a function or expression is missing", () => {
    expect(() => evaluateUrl("https://x.com/{pad({missing}, 2)}", data)).toThrow("No value for {missing}");
    expect(() => evaluateUrl("https://x.com/{round({missing})}", data)).toThrow("No value for {missing}");
    expect(() => evaluateUrl("https://x.com/{max({n}, {missing})}", data)).toThrow("No value for {missing}");
    expect(() => evaluateUrl("https://x.com/{{missing}[0:2]}", data)).toThrow("No value for {missing}");
    expect(() => evaluateUrl("https://x.com/{!pad({missing}, 2)}", data)).toThrow("No value for {missing}");
    expect(() => evaluateUrl("https://x.com/{pad({nul}, 2)}", data)).toThrow("No value for {nul}");
  });
  it("throws for a non-finite computed value", () => {
    expect(() => evaluateUrl("https://x.com/{round('x')}", data)).toThrow("No value");
  });
  it("display mode is unchanged: the same expressions give n/a", () => {
    expect(evaluate("{pad({missing}, 2)}", data)).toContain("n/a");
    expect(evaluate("{missing}", data)).toBe("n/a");
  });
  it("reports an unterminated block", () => {
    expect(() => evaluateUrl("https://x.com/{name", data)).toThrow("Missing }");
  });
});

