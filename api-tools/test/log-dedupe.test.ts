import { describe, expect, it } from "vitest";
import { LogDeduper } from "../src/log-dedupe";

function setup() {
  const lines: string[] = [];
  const sink = {
    info: (m: string) => lines.push(`I ${m}`),
    warn: (m: string) => lines.push(`W ${m}`),
    error: (m: string) => lines.push(`E ${m}`),
  };
  return { lines, d: new LogDeduper(sink) };
}

describe("LogDeduper", () => {
  it("logs the first message and suppresses identical repeats", () => {
    const { lines, d } = setup();
    for (let i = 0; i < 5; i++) d.log("k", "warn", "down");
    expect(lines).toEqual(["W down"]);
  });

  it("writes a summary when the message changes", () => {
    const { lines, d } = setup();
    d.log("k", "warn", "down");
    d.log("k", "warn", "down");
    d.log("k", "warn", "down");
    d.log("k", "warn", "timeout");
    expect(lines).toEqual(["W down", "W Previous message repeated 2 times", "W timeout"]);
  });

  it("uses the singular for one repeat", () => {
    const { lines, d } = setup();
    d.log("k", "error", "x");
    d.log("k", "error", "x");
    d.recovered("k");
    expect(lines).toEqual(["E x", "E Previous message repeated 1 time"]);
  });

  it("writes no summary when nothing repeated", () => {
    const { lines, d } = setup();
    d.log("k", "warn", "x");
    d.recovered("k");
    expect(lines).toEqual(["W x"]);
  });

  it("logs again after recovery", () => {
    const { lines, d } = setup();
    d.log("k", "warn", "down");
    d.log("k", "warn", "down");
    d.recovered("k");
    d.log("k", "warn", "down");
    expect(lines).toEqual(["W down", "W Previous message repeated 1 time", "W down"]);
  });

  it("keeps state per key", () => {
    const { lines, d } = setup();
    d.log("a", "warn", "down");
    d.log("b", "warn", "down");
    d.log("a", "warn", "down");
    d.log("b", "warn", "down");
    expect(lines).toEqual(["W down", "W down"]);
    d.recovered("a");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("W Previous message repeated 1 time");
  });

  it("treats a different level as a different message", () => {
    const { lines, d } = setup();
    d.log("k", "warn", "x");
    d.log("k", "error", "x");
    expect(lines).toEqual(["W x", "E x"]);
  });

  it("flushes the summary and drops all state when a key is cleared", () => {
    const { lines, d } = setup();
    d.log("k", "warn", "down");
    d.log("k", "warn", "down");
    d.log("k", "warn", "down");
    d.once("k", "warn", "redirect");
    expect(d.size).toBe(1);
    d.clear("k");
    expect(lines).toEqual(["W down", "W redirect", "W Previous message repeated 2 times"]);
    expect(d.size).toBe(0);
  });

  it("clear on an unknown key is harmless", () => {
    const { lines, d } = setup();
    d.clear("nope");
    expect(lines).toEqual([]);
    expect(d.size).toBe(0);
  });

  it("once() logs a message a single time per key, even across recoveries", () => {
    const { lines, d } = setup();
    d.once("k", "warn", "redirected");
    d.recovered("k");
    d.once("k", "warn", "redirected");
    d.once("other", "warn", "redirected");
    expect(lines).toEqual(["W redirected", "W redirected"]);
    d.clear("k");
    d.once("k", "warn", "redirected");
    expect(lines).toHaveLength(3);
  });

  it("truncates very long messages", () => {
    const { lines, d } = setup();
    d.log("k", "warn", "x".repeat(1000));
    expect(lines[0].length).toBeLessThan(320);
  });

  it("a failing poll every 250 ms logs one line, not hundreds", () => {
    const { lines, d } = setup();
    for (let i = 0; i < 1000; i++) d.log("k", "warn", "GET http://x/y failed: connect ECONNREFUSED");
    d.recovered("k");
    expect(lines).toEqual(["W GET http://x/y failed: connect ECONNREFUSED", "W Previous message repeated 999 times"]);
  });
});
