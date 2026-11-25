/** Simple Clock key lifecycle, with a stand-in for the SDK. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elgato/streamdeck", () => ({
  default: { logger: { warn: vi.fn() }, ui: { sendToPropertyInspector: vi.fn() } },
  action: () => (target: unknown) => target,
  SingletonAction: class {},
}));

import { Clock } from "../src/actions/clock";

const fakeKey = (id: string) => ({
  id,
  setTitle: vi.fn(async () => {}),
  setImage: vi.fn(async () => {}),
  setSettings: vi.fn(async () => {}),
});
const event = (action: object, settings: object) => ({ action, payload: { settings } }) as never;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-25T16:19:07Z"));
});
afterEach(() => vi.useRealTimers());

describe("Simple Clock action", () => {
  it("updates only when the text changes, and stops its timer with the last key", () => {
    const clock = new Clock();
    const a = fakeKey("a");
    const b = fakeKey("b");
    clock.onWillAppear(event(a, { timeZone: "UTC", timeFormat: "24s" }));
    clock.onWillAppear(event(b, { timeZone: "UTC" }));
    vi.advanceTimersByTime(1000);
    expect(a.setTitle.mock.calls).toEqual([["16:19:07"], ["16:19:08"]]);
    expect(b.setTitle.mock.calls).toEqual([["16:19"]]);

    clock.onWillDisappear(event(a, {}));
    expect(vi.getTimerCount()).toBe(1);
    clock.onWillDisappear(event(b, {}));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends the time again once Stream Deck reports a different title", () => {
    const clock = new Clock();
    const key = fakeKey("d");
    clock.onWillAppear(event(key, { timeZone: "UTC" }));
    clock.onTitleParametersDidChange({ action: key, payload: { title: "16:19" } } as never); // ours: nothing to do
    vi.advanceTimersByTime(400);
    expect(key.setTitle).toHaveBeenCalledTimes(1);
    clock.onTitleParametersDidChange({ action: key, payload: { title: "" } } as never);
    vi.advanceTimersByTime(400);
    expect(key.setTitle.mock.calls).toEqual([["16:19"], ["16:19"]]);
    clock.onWillDisappear(event(key, {}));
  });

  it("moves the old label setting to prefix", () => {
    const key = fakeKey("c");
    const clock = new Clock();
    clock.onWillAppear(event(key, { label: "Ottawa", timeZone: "UTC" }));
    expect(key.setSettings).toHaveBeenCalledWith({ prefix: "Ottawa", timeZone: "UTC" });
    expect(key.setTitle).toHaveBeenCalledWith("Ottawa\n16:19");
    clock.onWillDisappear(event(key, {}));
  });
});
