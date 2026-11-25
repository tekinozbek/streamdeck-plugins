import { describe, expect, it } from "vitest";
import { iconSpec, parseState, pressRequest, statusRequest, usesResponseIcon } from "../src/toggle";

describe("iconSpec", () => {
  it("defaults to the built-in icon", () => {
    expect(iconSpec({}, "on")).toEqual({ source: "default", value: "" });
    expect(iconSpec({ onIconSource: "default", onIcon: "x" }, "on")).toEqual({ source: "default", value: "" });
  });
  it("needs a value for file and response sources", () => {
    expect(iconSpec({ onIconSource: "file", onIcon: "  " }, "on").source).toBe("default");
    expect(iconSpec({ offIconSource: "response" }, "off").source).toBe("default");
  });
  it("reads each state's own settings, trimmed", () => {
    const s = { onIconSource: "file" as const, onIcon: " C:\\a.svg ", offIconSource: "response" as const, offIcon: "icons.off" };
    expect(iconSpec(s, "on")).toEqual({ source: "file", value: "C:\\a.svg" });
    expect(iconSpec(s, "off")).toEqual({ source: "response", value: "icons.off" });
  });
  it("ignores unknown sources", () => {
    expect(iconSpec({ onIconSource: "http" as never, onIcon: "x" }, "on").source).toBe("default");
  });
  it("knows when the response must be parsed for icons", () => {
    expect(usesResponseIcon({})).toBe(false);
    expect(usesResponseIcon({ onIconSource: "file", onIcon: "C:\\a.svg" })).toBe(false);
    expect(usesResponseIcon({ offIconSource: "response", offIcon: "x" })).toBe(true);
  });
});

describe("parseState", () => {
  it.each(["true", "TRUE", "on", "On", "1", "yes", " YES "])("treats %j as on by default", (v) => {
    expect(parseState(v)).toBe(true);
  });
  it.each(["false", "off", "0", "no", "null", "ACTIVE", "2", "[]"])("treats %j as off by default", (v) => {
    expect(parseState(v)).toBe(false);
  });
  it.each(["", "  ", "n/a", "N/A"])("returns undefined when there is no value (%j)", (v) => {
    expect(parseState(v)).toBeUndefined();
  });
  it("uses only the custom value when 'On when' is set, case-insensitively", () => {
    expect(parseState("ACTIVE", "active")).toBe(true);
    expect(parseState(" active ", " ACTIVE ")).toBe(true);
    expect(parseState("on", "active")).toBe(false); // defaults no longer apply
    expect(parseState("true", "active")).toBe(false);
  });
  it("still reports a missing value with a custom 'On when'", () => {
    expect(parseState("n/a", "n/a")).toBeUndefined();
    expect(parseState("", "x")).toBeUndefined();
  });
  it("ignores a blank 'On when'", () => {
    expect(parseState("on", "   ")).toBe(true);
  });
});

describe("request builders", () => {
  const s = {
    statusUrl: "http://s/status",
    statusHeaders: "A: 1",
    pollMs: 500,
    timeout: 5,
    onUrl: "http://s/on",
    onMethod: "PUT",
    onHeaders: "B: 2",
    onBody: '{"x":1}',
    offUrl: "http://s/off",
    offHeaders: "C: 3",
  };
  it("polls with GET and no body, whatever else is set", () => {
    expect(statusRequest(s)).toEqual({ url: "http://s/status", method: "GET", headers: "A: 1", timeout: 5, pollMs: 500 });
  });
  it("presses the Off endpoint when on, and the On endpoint when off", () => {
    expect(pressRequest(s, true)).toMatchObject({ url: "http://s/off", method: "POST", headers: "C: 3" });
    expect(pressRequest(s, false)).toMatchObject({ url: "http://s/on", method: "PUT", body: '{"x":1}' });
  });
  it("does not send the other endpoint's headers or body", () => {
    expect(pressRequest(s, true).body).toBeUndefined();
    expect(pressRequest(s, true).headers).not.toContain("B: 2");
  });
});
