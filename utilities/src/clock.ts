/** Pure clock helpers (no Stream Deck imports, so they can be unit-tested). */

export type ClockSettings = {
  prefix?: string; // optional text shown above the time
  label?: string; // old name of prefix, moved over when a key appears
  timeZone?: string; // IANA name, e.g. "Europe/Istanbul"; empty or "local" = this computer's time
  timeFormat?: TimeFormat; // missing = "24"
};

/** Hour cycle, with "s" added when seconds are shown. */
export type TimeFormat = "24" | "24s" | "12" | "12s";

export type SelectItem = { label: string; value: string } | { label: string; children: { label: string; value: string }[] };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone?: string): Intl.DateTimeFormat {
  const zone = !timeZone || timeZone === "local" ? undefined : timeZone;
  // The local zone is not cached: it can change while the plugin runs (travel, OS setting).
  let f = zone ? formatters.get(zone) : undefined;
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZone: zone,
    });
    if (zone) formatters.set(zone, f);
  }
  return f;
}

/** HH:mm or HH:mm:ss in the given zone, 12-hour ones followed by am/pm. Throws RangeError for an unknown zone. */
export function formatTime(now: Date, timeZone?: string, format: TimeFormat = "24"): string {
  const parts = formatter(timeZone).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  const twelve = format.startsWith("12");
  const hour24 = Number(part("hour"));
  const hour = twelve ? String(hour24 % 12 || 12).padStart(2, "0") : part("hour");
  let time = `${hour}:${part("minute")}`;
  if (format.endsWith("s")) time += `:${part("second")}`;
  // am/pm is added here rather than by Intl, whose spelling varies ("pm", "p.m.").
  return twelve ? `${time} ${hour24 < 12 ? "am" : "pm"}` : time;
}

/** The key's text: the optional prefix on its own line above the time. */
export function clockTitle(s: ClockSettings, now: Date): string {
  const prefix = (s.prefix ?? "").trim();
  let time: string;
  try {
    time = formatTime(now, s.timeZone, s.timeFormat);
  } catch {
    time = "BAD ZONE";
  }
  return prefix ? `${prefix}\n${time}` : time;
}

/** Dropdown entries: "Local time", "UTC", then every IANA zone grouped by region. */
export function timeZoneItems(zones: string[] = Intl.supportedValuesOf("timeZone")): SelectItem[] {
  const groups = new Map<string, { label: string; value: string }[]>();
  for (const zone of zones) {
    const slash = zone.indexOf("/");
    if (slash < 0) continue; // "UTC" and the like are listed separately
    const region = zone.slice(0, slash);
    const label = zone.slice(slash + 1).replace(/_/g, " ");
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region)!.push({ label, value: zone });
  }
  return [
    { label: "Local time", value: "local" },
    { label: "UTC", value: "UTC" },
    ...[...groups].map(([label, children]) => ({ label, children })),
  ];
}
