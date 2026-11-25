import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enforceLogCap, startLogCap } from "../src/log-cap";

const P = "io.test.plugin";
const opts = { maxTotalBytes: 100, maxFileBytes: 30, maxFiles: 4 };
let dir: string;

const write = (i: number, size: number, name = `${P}.${i}.log`) => fs.writeFileSync(path.join(dir, name), "x".repeat(size));
const names = () => fs.readdirSync(dir).sort();
const total = () => names().reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "logcap-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("enforceLogCap", () => {
  it("does nothing when under the limits", () => {
    write(0, 10);
    write(1, 20);
    enforceLogCap(dir, P, opts);
    expect(names()).toEqual([`${P}.0.log`, `${P}.1.log`]);
  });

  it("rotates a full live file and shifts older ones up", () => {
    write(0, 30);
    write(1, 11);
    enforceLogCap(dir, P, opts);
    expect(names()).toEqual([`${P}.1.log`, `${P}.2.log`]);
    expect(fs.statSync(path.join(dir, `${P}.1.log`)).size).toBe(30);
    expect(fs.statSync(path.join(dir, `${P}.2.log`)).size).toBe(11);
  });

  it("drops files that would exceed maxFiles", () => {
    write(0, 30);
    write(1, 5);
    write(2, 5);
    write(3, 5);
    enforceLogCap(dir, P, opts);
    expect(names()).toEqual([`${P}.1.log`, `${P}.2.log`, `${P}.3.log`]);
    expect(fs.statSync(path.join(dir, `${P}.1.log`)).size).toBe(30);
  });

  it("removes the oldest files until the total is under the cap", () => {
    write(0, 20);
    write(1, 29);
    write(2, 29);
    write(3, 29);
    enforceLogCap(dir, P, { ...opts, maxFiles: 10 });
    expect(total()).toBeLessThanOrEqual(100);
    expect(names()).toEqual([`${P}.0.log`, `${P}.1.log`, `${P}.2.log`]);
  });

  it("cleans up the SDK's 10-file layout down to the cap", () => {
    write(0, 3);
    for (let i = 1; i < 10; i++) write(i, 20);
    enforceLogCap(dir, P, opts);
    expect(names().length).toBeLessThanOrEqual(4);
    expect(total()).toBeLessThanOrEqual(100);
    expect(names()).toContain(`${P}.0.log`);
  });

  it("truncates a single file that is over the total cap", () => {
    write(0, 500);
    enforceLogCap(dir, P, { ...opts, maxFileBytes: 1000 });
    expect(fs.statSync(path.join(dir, `${P}.0.log`)).size).toBe(0);
  });

  it("leaves other files alone", () => {
    write(0, 5);
    write(0, 500, "other.0.log");
    write(0, 500, `${P}.notes.log`);
    write(0, 500, `${P}.1.txt`);
    enforceLogCap(dir, P, opts);
    expect(names()).toEqual(["other.0.log", `${P}.0.log`, `${P}.1.txt`, `${P}.notes.log`].sort());
  });

  it("ignores a missing folder and never throws", () => {
    expect(() => enforceLogCap(path.join(dir, "nope"), P, opts)).not.toThrow();
  });

  it("uses a 5 MiB total by default", () => {
    write(0, 1024 * 1024);
    for (let i = 1; i <= 8; i++) write(i, 1024 * 1024);
    enforceLogCap(dir, P);
    expect(total()).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
});

describe("startLogCap", () => {
  it("enforces immediately and returns an unref'd timer", () => {
    write(0, 500);
    const t = startLogCap(dir, P, 60_000, { ...opts, maxFileBytes: 1000 });
    expect(fs.statSync(path.join(dir, `${P}.0.log`)).size).toBe(0);
    expect(t.hasRef()).toBe(false);
    clearInterval(t);
  });
});
