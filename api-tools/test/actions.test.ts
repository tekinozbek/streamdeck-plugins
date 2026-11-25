/** Key lifecycle and display behaviour of the two actions, with a stand-in for the SDK and a local HTTP server. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const system = vi.hoisted(() => ({ openUrl: vi.fn(async (_url: string) => {}) }));

vi.mock("@elgato/streamdeck", () => ({
  default: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, system },
  action: () => (target: unknown) => target,
  SingletonAction: class {},
}));

import { ApiToggle } from "../src/actions/api-toggle";
import { CallWebhook } from "../src/actions/call-webhook";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const AFTER_DEBOUNCE = 800;

let server: http.Server;
let base: string;
let hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url!);
    const reply = () => {
      const long = "x".repeat(5000);
      res.end(JSON.stringify({ power: true, icon: '<svg viewBox="0 0 1 1"/>', long }));
    };
    if (req.url!.startsWith("/slow")) setTimeout(reply, 150);
    else reply();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** A key that records what was drawn on it; `delay` makes each SDK call take that long. */
function fakeKey(id: string, delay = 0) {
  const call = () => vi.fn(async (..._args: unknown[]) => void (delay && (await sleep(delay))));
  return { id, setTitle: call(), setImage: call(), setState: call(), showOk: call(), showAlert: call() };
}
type Key = ReturnType<typeof fakeKey>;
const event = (key: Key, settings: object) => ({ action: key, payload: { settings } }) as never;
const drawn = (key: Key) => key.setTitle.mock.calls.length + key.setImage.mock.calls.length + key.setState.mock.calls.length;

let cleanup: (() => void)[] = [];
beforeEach(() => {
  hits = [];
  system.openUrl.mockClear();
});
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
});

function appear<T extends ApiToggle | CallWebhook>(action: T, key: Key, settings: object) {
  const done = action.onWillAppear(event(key, settings)) as unknown as Promise<void> | void;
  const disappear = () => action.onWillDisappear(event(key, settings));
  cleanup.push(disappear);
  return { done, disappear };
}

describe("API Toggle", () => {
  const settings = () => ({ statusUrl: `${base}/status`, stateExpr: "power", pollMs: 250, onUrl: `${base}/on`, offUrl: `${base}/off` });

  it("doesn't start polling for a key that left while it was being drawn", async () => {
    const key = fakeKey("a", 30);
    const { done, disappear } = appear(new ApiToggle(), key, settings());
    disappear();
    await done;
    await sleep(600);
    expect(hits).toEqual([]);
  });

  it("draws nothing on a key that left during a press", async () => {
    const toggle = new ApiToggle();
    const key = fakeKey("b");
    const s = { ...settings(), offUrl: `${base}/slow/off` };
    const { disappear } = appear(toggle, key, s);
    await sleep(100);
    const press = toggle.onKeyDown(event(key, s));
    await sleep(30);
    disappear();
    const before = drawn(key);
    const asked = hits.length;
    await press;
    await sleep(400);
    expect(drawn(key)).toBe(before);
    expect(hits.length).toBe(asked);
  });

  it("ignores settings that arrive after the key left", async () => {
    const toggle = new ApiToggle();
    const key = fakeKey("c");
    appear(toggle, key, settings()).disappear();
    hits = [];
    toggle.onDidReceiveSettings(event(key, settings()));
    await sleep(AFTER_DEBOUNCE);
    expect(hits).toEqual([]);
  });

  it("forgets the state when the status settings change", async () => {
    const toggle = new ApiToggle();
    const key = fakeKey("d");
    appear(toggle, key, settings());
    await sleep(100);
    const changed = { ...settings(), statusUrl: "http://127.0.0.1:1/nothing" };
    toggle.onDidReceiveSettings(event(key, changed));
    await sleep(AFTER_DEBOUNCE);
    hits = [];
    await toggle.onKeyDown(event(key, changed));
    expect(key.showAlert).toHaveBeenCalled();
    expect(hits).toEqual([]); // neither On nor Off was sent
  });

  it("after a press, polls with settings that changed while it was running", async () => {
    const toggle = new ApiToggle();
    const key = fakeKey("k");
    const old = { ...settings(), pollMs: 60_000, offUrl: `${base}/slow/off` };
    appear(toggle, key, old);
    await sleep(100);
    // A press longer than the settings debounce, so the new settings take effect while it is still running.
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("/slow/off")) await sleep(900);
      return real(url, init);
    });
    try {
      const press = toggle.onKeyDown(event(key, old));
      await sleep(20);
      toggle.onDidReceiveSettings(event(key, { ...old, statusUrl: `${base}/changed` }));
      hits = [];
      await press;
    } finally {
      spy.mockRestore();
    }
    expect(hits.filter((h) => h !== "/slow/off")).toEqual(["/changed"]);
  });

  it("shows its extra states by image path, without reading shipped files", async () => {
    const key = fakeKey("e");
    appear(new ApiToggle(), key, {});
    await sleep(50);
    expect(key.setImage).toHaveBeenCalledWith("imgs/actions/toggle/unknown@2x.png");
  });
});

describe("Webhook", () => {
  const get = () => ({ url: `${base}/data`, method: "GET" });

  it("ignores settings that arrive after the key left", async () => {
    const webhook = new CallWebhook();
    const key = fakeKey("f");
    appear(webhook, key, {}).disappear();
    webhook.onDidReceiveSettings(event(key, { ...get(), pollMs: 250 }));
    await sleep(AFTER_DEBOUNCE);
    expect(hits).toEqual([]);
  });

  it("keeps an expression error visible instead of drawing the icon over it", async () => {
    const webhook = new CallWebhook();
    const key = fakeKey("g");
    const s = { ...get(), jsonPath: "={power} +", iconPath: "icon" };
    appear(webhook, key, s);
    await webhook.onKeyDown(event(key, s));
    expect(key.setImage).toHaveBeenCalledTimes(1); // only the error tile
    expect(key.showAlert).toHaveBeenCalled();
  });

  it("shortens long titles and doesn't re-send an unchanged one", async () => {
    const webhook = new CallWebhook();
    const key = fakeKey("h");
    const s = { ...get(), jsonPath: "long" };
    appear(webhook, key, s);
    await webhook.onKeyDown(event(key, s));
    await webhook.onKeyDown(event(key, s));
    expect(key.setTitle.mock.calls).toEqual([["x".repeat(200)]]);
  });

  it("doesn't blank the title when other settings change", async () => {
    const webhook = new CallWebhook();
    const key = fakeKey("l");
    const s = { ...get(), pollMs: 60_000 };
    appear(webhook, key, s);
    await sleep(100);
    webhook.onDidReceiveSettings(event(key, { ...s, suffix: "!" }));
    await sleep(AFTER_DEBOUNCE);
    expect(key.setTitle.mock.calls.map((c) => c[0])).not.toContain("");
  });

  it("sends an unchanged title again once Stream Deck reports a different one", async () => {
    const webhook = new CallWebhook();
    const key = fakeKey("m");
    const s = { ...get(), jsonPath: "power" };
    appear(webhook, key, s);
    await webhook.onKeyDown(event(key, s));
    webhook.onTitleParametersDidChange({ action: key, payload: { title: "true" } } as never); // ours: nothing to do
    await webhook.onKeyDown(event(key, s));
    expect(key.setTitle).toHaveBeenCalledTimes(1);
    webhook.onTitleParametersDidChange({ action: key, payload: { title: "typed" } } as never);
    await webhook.onKeyDown(event(key, s));
    expect(key.setTitle).toHaveBeenCalledTimes(2);
  });

  it("clears the title when the Expression is removed from a key that doesn't poll", async () => {
    const webhook = new CallWebhook();
    const key = fakeKey("i");
    const s = { ...get(), jsonPath: "power" };
    appear(webhook, key, s);
    await webhook.onKeyDown(event(key, s));
    webhook.onDidReceiveSettings(event(key, get()));
    await sleep(AFTER_DEBOUNCE);
    expect(key.setTitle.mock.calls).toEqual([["true"], [""]]);
  });

  it("opens the parsed form of a URL", async () => {
    const webhook = new CallWebhook();
    const key = fakeKey("j");
    const s = { onPress: "url", openUrl: "  HTTPS://Example.com/a b  " };
    await webhook.onKeyDown(event(key, s));
    expect(system.openUrl).toHaveBeenCalledWith("https://example.com/a%20b");
  });
});
