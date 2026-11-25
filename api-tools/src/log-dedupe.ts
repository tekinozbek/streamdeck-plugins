/**
 * Collapses repeated log lines per key. A failing poll can fire every 250 ms; the same message is logged
 * once, identical repeats are counted silently, and a "repeated N times" line is written when the
 * message changes, the key recovers, or the key goes away.
 */

export type LogLevel = "info" | "warn" | "error";
export type LogSink = Record<LogLevel, (message: string) => unknown>;

const MAX_MESSAGE = 300;

type State = { level: LogLevel; message: string; repeats: number };

export class LogDeduper {
  private last = new Map<string, State>();
  private seen = new Map<string, Set<string>>();

  constructor(private sink: LogSink) {}

  /** Log `message` for `key` unless it is identical to the previous one for that key. */
  log(key: string, level: LogLevel, message: string): void {
    const msg = message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}...` : message;
    const prev = this.last.get(key);
    if (prev && prev.level === level && prev.message === msg) {
      prev.repeats++;
      return;
    }
    this.flush(key);
    this.last.set(key, { level, message: msg, repeats: 0 });
    this.sink[level](msg);
  }

  /** Log `message` for `key` only the first time it is seen (until the key is cleared); not affected by recovered(). */
  once(key: string, level: LogLevel, message: string): void {
    let set = this.seen.get(key);
    if (!set) this.seen.set(key, (set = new Set()));
    if (set.has(message)) return;
    if (set.size >= 20) set.clear(); // bounded; a changing message just logs again
    set.add(message);
    this.sink[level](message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}...` : message);
  }

  /** The key worked again: write any pending summary and forget the last message, so a new failure logs afresh. */
  recovered(key: string): void {
    this.flush(key);
    this.last.delete(key);
  }

  /** The key went away: write any pending summary and drop all state for it. */
  clear(key: string): void {
    this.recovered(key);
    this.seen.delete(key);
  }

  /** Number of keys with state, for tests / leak checks. */
  get size(): number {
    return new Set([...this.last.keys(), ...this.seen.keys()]).size;
  }

  private flush(key: string): void {
    const s = this.last.get(key);
    if (s && s.repeats > 0) {
      this.sink[s.level](`Previous message repeated ${s.repeats} time${s.repeats === 1 ? "" : "s"}`);
      s.repeats = 0;
    }
  }
}
