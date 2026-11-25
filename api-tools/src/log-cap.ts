/**
 * Keeps the plugin's log folder small. The Stream Deck SDK's file logger rotates at 50 MB and keeps 10
 * files (about 500 MB), with no way to change that, so this trims the same files itself:
 * the live file (<prefix>.0.log) is rotated at maxFileBytes, files beyond maxFiles are removed, and
 * the total is held at or under maxTotalBytes. The SDK opens the log by path for every write, so
 * renaming/removing files underneath it is safe.
 */
import fs from "node:fs";
import path from "node:path";

export type LogCapOptions = { maxTotalBytes: number; maxFileBytes: number; maxFiles: number };

export const DEFAULT_LOG_CAP: LogCapOptions = { maxTotalBytes: 5 * 1024 * 1024, maxFileBytes: 1024 * 1024, maxFiles: 5 };

type LogFile = { index: number; file: string; size: number };

function listLogs(dir: string, prefix: string): LogFile[] {
  const out: LogFile[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(`${prefix}.`) || !name.endsWith(".log")) continue;
    const mid = name.slice(prefix.length + 1, -4);
    if (!/^\d+$/.test(mid)) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) out.push({ index: Number(mid), file, size: st.size });
    } catch {
      /* vanished meanwhile */
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Rotate and trim `<dir>/<prefix>.<n>.log`. Never throws: logging housekeeping must not take the plugin down. */
export function enforceLogCap(dir: string, prefix: string, opts: LogCapOptions = DEFAULT_LOG_CAP): void {
  try {
    if (!fs.existsSync(dir)) return;
    let files = listLogs(dir, prefix);

    // Live file is full: shift every file up one index (the oldest fall off the end).
    if (files[0]?.index === 0 && files[0].size >= opts.maxFileBytes) {
      for (const f of [...files].reverse()) {
        try {
          if (f.index + 1 >= opts.maxFiles) fs.rmSync(f.file);
          else fs.renameSync(f.file, path.join(dir, `${prefix}.${f.index + 1}.log`));
        } catch {
          /* leave it; the total check below still applies */
        }
      }
      files = listLogs(dir, prefix);
    }

    // Too many files (e.g. left by the SDK's own 10-file rotation), or over the total: drop the oldest.
    let total = files.reduce((n, f) => n + f.size, 0);
    while (files.length > 0 && (files.length > opts.maxFiles || total > opts.maxTotalBytes)) {
      const oldest = files[files.length - 1];
      try {
        if (files.length === 1) {
          fs.truncateSync(oldest.file, 0); // a single file over the cap: keep the file, drop its content
          total -= oldest.size;
          break;
        }
        fs.rmSync(oldest.file);
      } catch {
        break;
      }
      total -= oldest.size;
      files.pop();
    }
  } catch {
    /* ignore */
  }
}

/** Enforce the cap now and then every `intervalMs`. The timer doesn't keep the process alive. */
export function startLogCap(dir: string, prefix: string, intervalMs = 60_000, opts: LogCapOptions = DEFAULT_LOG_CAP): NodeJS.Timeout {
  enforceLogCap(dir, prefix, opts);
  const t = setInterval(() => enforceLogCap(dir, prefix, opts), intervalMs);
  t.unref();
  return t;
}
