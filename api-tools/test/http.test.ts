import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  describeError,
  fetchNoRedirects,
  isExpectedNetworkError,
  isJson,
  parseHeaders,
  pollTimeoutMs,
  readLimited,
  RedirectError,
  requestTimeoutMs,
  safeUrl,
  send,
  TooLargeError,
} from "../src/http";

type Seen = { server: "A" | "B"; method: string; url: string; key: string | null; ctype: string | null; body: string };
let seen: Seen[] = [];
let A: http.Server, B: http.Server;
let a = "", b = "";

const listen = (h: http.RequestListener) =>
  new Promise<http.Server>((res) => {
    const s = http.createServer(h);
    s.listen(0, "127.0.0.1", () => res(s));
  });

function record(server: "A" | "B", req: http.IncomingMessage, body: string) {
  seen.push({
    server,
    method: req.method!,
    url: req.url!,
    key: (req.headers["x-api-key"] as string) ?? null,
    ctype: (req.headers["content-type"] as string) ?? null,
    body,
  });
}
const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((res) => {
    let t = "";
    req.on("data", (c) => (t += c));
    req.on("end", () => res(t));
  });

beforeAll(async () => {
  B = await listen(async (req, res) => {
    record("B", req, await readBody(req));
    res.end("from-b");
  });
  b = `http://127.0.0.1:${(B.address() as AddressInfo).port}`;
  A = await listen(async (req, res) => {
    const body = await readBody(req);
    record("A", req, body);
    const u = new URL(req.url!, "http://x");
    const redirect = u.pathname.match(/^\/r(\d{3})(x)?(\/.*)?$/); // /r307 -> same origin, /r307x -> cross origin to B
    if (redirect) {
      const target = redirect[2] ? `${b}/landed` : `/landed${u.search}`;
      res.writeHead(Number(redirect[1]), { location: target });
      return res.end();
    }
    switch (u.pathname) {
      case "/loop":
        res.writeHead(302, { location: "/loop" });
        return res.end();
      case "/bad-proto":
        res.writeHead(302, { location: "file:///etc/passwd" });
        return res.end();
      case "/ftp":
        res.writeHead(302, { location: "ftp://example.com/x" });
        return res.end();
      case "/no-location":
        res.writeHead(302);
        return res.end("no location");
      case "/chain": {
        const n = Number(u.searchParams.get("n") ?? "0");
        if (n >= Number(u.searchParams.get("limit"))) return res.end("end-of-chain");
        res.writeHead(302, { location: `/chain?n=${n + 1}&limit=${u.searchParams.get("limit")}` });
        return res.end();
      }
      case "/rel":
        res.writeHead(301, { location: "sub/page" });
        return res.end();
      case "/abs-same":
        res.writeHead(302, { location: `${a}/landed` });
        return res.end();
      case "/hang":
        return; // never answers
      case "/slow-body":
        res.write("start");
        return; // headers sent, body never finishes
      case "/big":
        return res.end("x".repeat(1024 * 1024 + 10));
      case "/big-chunked":
        res.write("x".repeat(600_000));
        res.write("x".repeat(600_000));
        return res.end();
      case "/exact":
        return res.end("x".repeat(1024 * 1024));
      case "/404":
        res.writeHead(404);
        return res.end("nope");
      case "/json":
        res.setHeader("content-type", "application/json");
        return res.end('{"ok":true}');
      default:
        return res.end("ok-a");
    }
  });
  a = `http://127.0.0.1:${(A.address() as AddressInfo).port}`;
});
afterAll(() => {
  A.closeAllConnections();
  B.closeAllConnections();
  A.close();
  B.close();
});
beforeEach(() => {
  seen = [];
});

const sig = (ms = 5000) => AbortSignal.timeout(ms);
const H = { "X-Api-Key": "SECRET" };
const fetchF = (path: string, method = "GET", body?: string, headers: Record<string, string> = H, opts = {}) =>
  fetchNoRedirects(path.startsWith("http") ? path : a + path, method, headers, body, sig(), opts);

describe("helpers", () => {
  it("parseHeaders", () => {
    expect(parseHeaders("A: 1\r\nB:two words\n\n  C : x:y \nnocolon\n: empty")).toEqual({ A: "1", B: "two words", C: "x:y" });
    expect(parseHeaders()).toEqual({});
  });
  it("isJson", () => {
    expect(isJson('{"a":1}')).toBe(true);
    expect(isJson("123")).toBe(true);
    expect(isJson("hello")).toBe(false);
    expect(isJson("")).toBe(false);
  });
  it("safeUrl hides query, fragment and credentials", () => {
    expect(safeUrl("https://user:pw@example.com:8443/a/b?token=SECRET#frag")).toBe("https://example.com:8443/a/b");
    expect(safeUrl("not a url")).toBe("(invalid url)");
    expect(safeUrl()).toBe("(invalid url)");
  });
  it("requestTimeoutMs: 1-120 s, empty/0/invalid = 10 s, capped while polling", () => {
    expect(requestTimeoutMs({}, false)).toBe(10_000);
    expect(requestTimeoutMs({ timeout: 0 }, false)).toBe(10_000);
    expect(requestTimeoutMs({ timeout: "abc" as unknown as number }, false)).toBe(10_000);
    expect(requestTimeoutMs({ timeout: 5 }, false)).toBe(5000);
    expect(requestTimeoutMs({ timeout: -3 }, false)).toBe(1000);
  });
  it("requestTimeoutMs clamps to the range", () => {
    expect(requestTimeoutMs({ timeout: 0.2 }, false)).toBe(1000);
    expect(requestTimeoutMs({ timeout: 1 }, false)).toBe(1000);
    expect(requestTimeoutMs({ timeout: 120 }, false)).toBe(120_000);
    expect(requestTimeoutMs({ timeout: 9999 }, false)).toBe(120_000);
  });
  it("polling waits at most max(3 s, 3x interval)", () => {
    expect(pollTimeoutMs({ pollMs: 0 })).toBe(3000);
    expect(pollTimeoutMs({ pollMs: 250 })).toBe(3000);
    expect(pollTimeoutMs({ pollMs: 5000 })).toBe(15_000);
    expect(requestTimeoutMs({ timeout: 60, pollMs: 1000 }, true)).toBe(3000);
    expect(requestTimeoutMs({ timeout: 2, pollMs: 1000 }, true)).toBe(2000);
    expect(requestTimeoutMs({ timeout: 60, pollMs: 10_000 }, true)).toBe(30_000);
  });
});

describe("fetchNoRedirects: redirects are refused", () => {
  it("returns a non-redirect as is", async () => {
    const res = await fetchF("/x");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok-a");
    expect(seen).toHaveLength(1);
  });
  it("refuses every redirect status with a Location header, and never makes a second request", async () => {
    for (const code of [301, 302, 303, 307, 308]) {
      seen = [];
      await expect(fetchF(`/r${code}`)).rejects.toBeInstanceOf(RedirectError);
      expect(seen).toHaveLength(1);
    }
  });
  it("refuses same-origin and cross-origin redirects alike, for every method", async () => {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/r307", "/r302x", "/rel", "/abs-same"]) {
        seen = [];
        await expect(fetchF(path, method, method === "GET" || method === "HEAD" ? undefined : "body")).rejects.toBeInstanceOf(RedirectError);
        expect(seen.filter((s) => s.server === "B")).toHaveLength(0); // nothing reached the other host
        expect(seen).toHaveLength(1);
      }
    }
  });
  it("refuses redirects to other protocols and loops without following them", async () => {
    for (const path of ["/bad-proto", "/ftp", "/loop"]) {
      seen = [];
      await expect(fetchF(path)).rejects.toBeInstanceOf(RedirectError);
      expect(seen).toHaveLength(1);
    }
  });
  it("the error message names the status but not the target, headers, body or query", async () => {
    const err = await fetchF("/r302x?token=SECRET", "POST", "BODYSECRET").catch((e) => e);
    expect(err.message).toBe("Refused HTTP 302 redirect; redirects are not followed");
    expect(err.message).not.toMatch(/127\.0\.0\.1|SECRET/);
  });
  it("returns a 3xx without Location as the response", async () => {
    const res = await fetchF("/no-location");
    expect(res.status).toBe(302);
    expect(await res.text()).toBe("no location");
  });
  it("returns 304 and 404 without following", async () => {
    expect((await fetchF("/404")).status).toBe(404);
    expect(seen).toHaveLength(1);
  });
  it("asks fetch not to follow redirects", async () => {
    let init: RequestInit | undefined;
    const fake = (async (_u: unknown, i?: RequestInit) => ((init = i), new Response("x"))) as unknown as typeof fetch;
    await fetchNoRedirects(a, "GET", {}, undefined, sig(), { fetch: fake });
    expect(init?.redirect).toBe("manual");
  });
});

describe("fetchNoRedirects: failures", () => {
  it("rejects an invalid URL", async () => {
    await expect(fetchF("http://")).rejects.toThrow();
    await expect(fetchNoRedirects("nonsense", "GET", {}, undefined, sig())).rejects.toThrow();
  });
  it("fails to connect to a closed port", async () => {
    const err = await fetchNoRedirects("http://127.0.0.1:1/", "GET", {}, undefined, sig()).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(isExpectedNetworkError(err)).toBe(true);
    expect(describeError(err)).toMatch(/ECONNREFUSED|fetch failed/);
  });
});

describe("timeouts and abort", () => {
  it("times out a hung server with a TimeoutError", async () => {
    const err = await fetchNoRedirects(`${a}/hang`, "GET", {}, undefined, AbortSignal.timeout(300)).catch((e) => e);
    expect(err.name).toBe("TimeoutError");
    expect(describeError(err)).toBe("timed out");
    expect(isExpectedNetworkError(err)).toBe(true);
  });
  it("aborts when the caller's signal fires", async () => {
    const c = new AbortController();
    const p = fetchNoRedirects(`${a}/hang`, "GET", {}, undefined, c.signal).catch((e) => e);
    setTimeout(() => c.abort(), 100);
    const err = await p;
    expect(err.name).toBe("AbortError");
    expect(c.signal.aborted).toBe(true);
  });
  it("send(): the Timeout setting applies (1 s minimum) and a stalled body also times out", async () => {
    const t0 = Date.now();
    const err = await send({ url: `${a}/hang`, method: "GET", timeout: 1 }, new AbortController().signal, false).catch((e) => e);
    expect(err.name).toBe("TimeoutError");
    expect(Date.now() - t0).toBeLessThan(3000);
    const err2 = await send({ url: `${a}/slow-body`, method: "GET", timeout: 1 }, new AbortController().signal, false).catch((e) => e);
    expect(["TimeoutError", "AbortError"]).toContain(err2.name);
  }, 10_000);
  it("send(): aborting the controller cancels the request", async () => {
    const c = new AbortController();
    const p = send({ url: `${a}/hang`, method: "GET", timeout: 30 }, c.signal, false).catch((e) => e);
    setTimeout(() => c.abort(), 100);
    expect((await p).name).toBe("AbortError");
  });
});

describe("readLimited / response size", () => {
  it("reads a body under the limit", async () => {
    expect(await readLimited(new Response("hello"), 10)).toBe("hello");
    expect(await readLimited(new Response(null), 10)).toBe("");
  });
  it("accepts a body of exactly the limit, rejects one byte more", async () => {
    expect(await readLimited(new Response("x".repeat(10)), 10)).toHaveLength(10);
    await expect(readLimited(new Response("x".repeat(11)), 10)).rejects.toBeInstanceOf(TooLargeError);
  });
  it("rejects early on a declared Content-Length over the limit", async () => {
    const res = new Response("x", { headers: { "content-length": "999" } });
    await expect(readLimited(res, 10)).rejects.toThrow(/too large \(999 bytes\)/);
  });
  it("decodes multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("héllo €");
    const stream = new ReadableStream({
      start(c) {
        for (const x of bytes) c.enqueue(new Uint8Array([x]));
        c.close();
      },
    });
    expect(await readLimited(new Response(stream), 100)).toBe("héllo €");
  });
  it("send(): rejects a response over 1 MiB, with and without Content-Length", async () => {
    const e1 = await send({ url: `${a}/big`, method: "GET" }, new AbortController().signal, false).catch((e) => e);
    expect(e1).toBeInstanceOf(TooLargeError);
    const e2 = await send({ url: `${a}/big-chunked`, method: "GET" }, new AbortController().signal, false).catch((e) => e);
    expect(e2).toBeInstanceOf(TooLargeError);
    expect(isExpectedNetworkError(e2)).toBe(true);
  });
  it("send(): accepts exactly 1 MiB", async () => {
    const r = await send({ url: `${a}/exact`, method: "GET" }, new AbortController().signal, false);
    expect(r.text).toHaveLength(1024 * 1024);
  });
});

describe("send()", () => {
  const sig0 = () => new AbortController().signal;
  it("returns status, ok and text", async () => {
    expect(await send({ url: `${a}/json`, method: "GET" }, sig0(), false)).toEqual({ ok: true, status: 200, text: '{"ok":true}' });
    expect(await send({ url: `${a}/404`, method: "GET" }, sig0(), false)).toEqual({ ok: false, status: 404, text: "nope" });
  });
  it("defaults to POST", async () => {
    await send({ url: `${a}/x` }, sig0(), false);
    expect(seen[0].method).toBe("POST");
  });
  it("sends custom headers", async () => {
    await send({ url: `${a}/x`, method: "GET", headers: "X-Api-Key: abc\nX-Other: 1" }, sig0(), false);
    expect(seen[0].key).toBe("abc");
  });
  it("sends a JSON body as application/json unless Content-Type is set (any case)", async () => {
    await send({ url: `${a}/x`, method: "POST", body: '{"a":1}' }, sig0(), false);
    expect(seen[0]).toMatchObject({ ctype: "application/json", body: '{"a":1}' });
    seen = [];
    await send({ url: `${a}/x`, method: "POST", body: '{"a":1}', headers: "content-type: text/custom" }, sig0(), false);
    expect(seen[0].ctype).toBe("text/custom");
    seen = [];
    await send({ url: `${a}/x`, method: "POST", body: "plain text" }, sig0(), false);
    expect(seen[0].ctype).toMatch(/^text\/plain/);
  });
  it("never sends a body with GET or HEAD", async () => {
    await send({ url: `${a}/x`, method: "get", body: '{"a":1}' }, sig0(), false);
    await send({ url: `${a}/x`, method: "HEAD", body: "x" }, sig0(), false);
    expect(seen.map((s) => [s.method, s.body, s.ctype])).toEqual([["GET", "", null], ["HEAD", "", null]]);
  });
  it("sends PUT / PATCH / DELETE bodies", async () => {
    for (const m of ["PUT", "PATCH", "DELETE"]) await send({ url: `${a}/x`, method: m, body: "b" }, sig0(), false);
    expect(seen.map((s) => [s.method, s.body])).toEqual([["PUT", "b"], ["PATCH", "b"], ["DELETE", "b"]]);
  });
  it("refuses a redirect with headers and body, and sends nothing elsewhere", async () => {
    await expect(send({ url: `${a}/r307`, method: "POST", body: "b", headers: "X-Api-Key: K" }, sig0(), false)).rejects.toBeInstanceOf(RedirectError);
    await expect(send({ url: `${a}/r307x`, method: "POST", body: "b", headers: "X-Api-Key: K" }, sig0(), false)).rejects.toBeInstanceOf(RedirectError);
    expect(seen.filter((s) => s.server === "B")).toHaveLength(0);
    expect(seen).toHaveLength(2);
  });
  it("a polling GET that meets a redirect fails with a RedirectError too", async () => {
    await expect(send({ url: `${a}/r302`, method: "GET", pollMs: 1000 }, sig0(), true)).rejects.toBeInstanceOf(RedirectError);
  });
});

describe("error description", () => {
  it("describes errors on one line", () => {
    expect(describeError(new TooLargeError("Response too large (5 bytes)"))).toBe("Response too large (5 bytes)");
    expect(describeError(new RedirectError("nope"))).toBe("nope");
    expect(describeError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toBe("fetch failed (ECONNREFUSED)");
    expect(describeError(new Error("plain"))).toBe("plain");
    expect(describeError("str")).toBe("str");
    expect(describeError(new Error("x\nstack-ish")).includes("    at ")).toBe(false);
  });
  it("classifies expected network errors", () => {
    expect(isExpectedNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isExpectedNetworkError(new RedirectError("x"))).toBe(true);
    expect(isExpectedNetworkError(new TooLargeError("x"))).toBe(true);
    expect(isExpectedNetworkError(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe(true);
    expect(isExpectedNetworkError(new RangeError("bug"))).toBe(false);
    expect(isExpectedNetworkError(undefined)).toBe(false);
  });
});
