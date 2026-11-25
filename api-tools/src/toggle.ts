/**
 * Pure helpers for the API Toggle action (no Stream Deck imports, so they can be unit-tested).
 */

import type { RequestSettings } from "./http";

export type IconSource = "default" | "file" | "response";

export type ToggleSettings = {
  // Status request (polled with GET)
  statusUrl?: string;
  statusHeaders?: string;
  pollMs?: number;
  timeout?: number; // seconds, used by all three requests
  stateExpr?: string; // expression evaluated on the status JSON
  onWhen?: string; // if set, the key is "on" only when the value equals this (case-insensitive)

  // Optional custom icon per state: default (built-in), a file on disk, or an expression on the status JSON
  offIconSource?: IconSource;
  offIcon?: string;
  onIconSource?: IconSource;
  onIcon?: string;

  // Press while OFF -> turn on
  onUrl?: string;
  onMethod?: string;
  onHeaders?: string;
  onBody?: string;

  // Press while ON -> turn off
  offUrl?: string;
  offMethod?: string;
  offHeaders?: string;
  offBody?: string;
};

const DEFAULT_ON = new Set(["true", "on", "1", "yes"]);
const MISSING = new Set(["", "n/a"]);

/**
 * Decide on/off from the text an expression produced. Returns `undefined` when there is no value at all
 * (empty or "n/a"), so the caller can show an error instead of guessing.
 * With `onWhen` set, only that value counts as on; otherwise true / on / 1 / yes (any case) do.
 */
export function parseState(value: string, onWhen?: string): boolean | undefined {
  const v = value.trim();
  if (MISSING.has(v.toLowerCase())) return undefined;
  const custom = (onWhen ?? "").trim();
  if (custom) return v.toLowerCase() === custom.toLowerCase();
  return DEFAULT_ON.has(v.toLowerCase());
}

/** Where the icon for a state comes from. An unknown source or an empty value means the built-in icon. */
export function iconSpec(s: ToggleSettings, state: "on" | "off"): { source: IconSource; value: string } {
  const source = state === "on" ? s.onIconSource : s.offIconSource;
  const value = ((state === "on" ? s.onIcon : s.offIcon) ?? "").trim();
  if ((source === "file" || source === "response") && value) return { source, value };
  return { source: "default", value: "" };
}

/** True if either state takes its icon from the response, so the status JSON must be parsed even without an expression. */
export function usesResponseIcon(s: ToggleSettings): boolean {
  return iconSpec(s, "on").source === "response" || iconSpec(s, "off").source === "response";
}

/** Settings for the status poll: always GET, no body. */
export function statusRequest(s: ToggleSettings): RequestSettings {
  return { url: s.statusUrl, method: "GET", headers: s.statusHeaders, timeout: s.timeout, pollMs: s.pollMs };
}

/** Settings for the press call: turn off when the key is on, turn on when it is off. */
export function pressRequest(s: ToggleSettings, currentlyOn: boolean): RequestSettings {
  return currentlyOn
    ? { url: s.offUrl, method: s.offMethod ?? "POST", headers: s.offHeaders, body: s.offBody, timeout: s.timeout }
    : { url: s.onUrl, method: s.onMethod ?? "POST", headers: s.onHeaders, body: s.onBody, timeout: s.timeout };
}
