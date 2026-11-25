import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clockTitle, formatTime, timeZoneItems } from "../src/clock";

const NOW = new Date("2026-11-25T16:19:00Z"); // winter: Toronto UTC-5, Istanbul UTC+3

describe("formatTime", () => {
  it("formats 24-hour HH:MM per zone", () => {
    expect(formatTime(NOW, "America/Toronto")).toBe("11:19");
    expect(formatTime(NOW, "Europe/Istanbul")).toBe("19:19");
    expect(formatTime(NOW, "UTC")).toBe("16:19");
  });
  it("shows midnight as 00, not 24", () => {
    expect(formatTime(new Date("2026-11-25T00:05:00Z"), "UTC")).toBe("00:05");
  });
  it("follows daylight saving", () => {
    expect(formatTime(new Date("2026-07-01T16:00:00Z"), "America/Toronto")).toBe("12:00");
  });
  it("handles half-hour zones", () => {
    expect(formatTime(NOW, "Asia/Kolkata")).toBe("21:49");
  });
  it("treats empty and 'local' as the computer's zone", () => {
    expect(formatTime(NOW, "")).toBe(formatTime(NOW));
    expect(formatTime(NOW, "local")).toBe(formatTime(NOW));
  });
  it("throws for an unknown zone", () => {
    expect(() => formatTime(NOW, "Mars/Olympus")).toThrow(RangeError);
  });
});

describe("time formats", () => {
  const at = (time: string) => new Date(`2026-11-25T${time}Z`);

  it("offers 24 and 12 hour, with and without seconds", () => {
    const t = at("16:19:07");
    expect(formatTime(t, "UTC", "24")).toBe("16:19");
    expect(formatTime(t, "UTC", "24s")).toBe("16:19:07");
    expect(formatTime(t, "UTC", "12")).toBe("04:19 pm");
    expect(formatTime(t, "UTC", "12s")).toBe("04:19:07 pm");
  });
  it("shows 12 at midnight and noon in 12-hour formats", () => {
    expect(formatTime(at("00:05:00"), "UTC", "12")).toBe("12:05 am");
    expect(formatTime(at("11:59:00"), "UTC", "12")).toBe("11:59 am");
    expect(formatTime(at("12:00:00"), "UTC", "12")).toBe("12:00 pm");
  });
  it("is used by the key text", () => {
    expect(clockTitle({ prefix: "Ottawa", timeZone: "America/Toronto", timeFormat: "12s" }, at("16:19:07"))).toBe(
      "Ottawa\n11:19:07 am",
    );
  });
});

describe("clockTitle", () => {
  it("puts the prefix above the time", () => {
    expect(clockTitle({ prefix: "Ottawa", timeZone: "America/Toronto" }, NOW)).toBe("Ottawa\n11:19");
  });
  it("shows only the time without a prefix", () => {
    expect(clockTitle({ timeZone: "UTC" }, NOW)).toBe("16:19");
    expect(clockTitle({ prefix: "   ", timeZone: "UTC" }, NOW)).toBe("16:19");
  });
  it("says so for a bad zone instead of failing", () => {
    expect(clockTitle({ prefix: "X", timeZone: "Nope/Nope" }, NOW)).toBe("X\nBAD ZONE");
  });
});

describe("timeZoneItems", () => {
  const items = timeZoneItems();
  const values = items.flatMap((i) => ("children" in i ? i.children.map((c) => c.value) : [i.value]));

  it("starts with Local time and UTC", () => {
    expect(values.slice(0, 2)).toEqual(["local", "UTC"]);
  });
  it("includes real zones, each usable", () => {
    expect(values).toContain("Europe/Istanbul");
    expect(values).toContain("America/Toronto");
    for (const v of values) expect(() => formatTime(NOW, v), v).not.toThrow();
  });
  it("groups by region with readable names", () => {
    expect(timeZoneItems(["America/New_York", "America/Argentina/Salta", "UTC"]).slice(2)).toEqual([
      {
        label: "America",
        children: [
          { label: "New York", value: "America/New_York" },
          { label: "Argentina/Salta", value: "America/Argentina/Salta" },
        ],
      },
    ]);
  });
});

describe("manifest and inspector", () => {
  const sd = path.resolve(__dirname, "..", "io.github.tekinozbek.utilities.sdPlugin");
  const manifest = JSON.parse(fs.readFileSync(path.join(sd, "manifest.json"), "utf8"));
  const html = fs.readFileSync(path.join(sd, "ui", "clock.html"), "utf8");

  it("uses the settings the action reads", () => {
    expect([...html.matchAll(/setting="(\w+)"/g)].map((m) => m[1])).toEqual(["prefix", "timeZone", "timeFormat"]);
    expect(manifest.Actions[0].UserTitleEnabled).not.toBe(false); // keeps the T style menu
  });
  it("ships the inspector files and loads nothing remote", () => {
    expect(manifest.Actions[0].PropertyInspectorPath).toBe("ui/clock.html");
    expect(fs.existsSync(path.join(sd, "ui", "sdpi-components.js"))).toBe(true);
    expect(html).not.toMatch(/src="https?:/);
  });
});
