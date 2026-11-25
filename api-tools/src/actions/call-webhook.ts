import streamDeck, {
  action,
  DidReceiveSettingsEvent,
  KeyAction,
  KeyDownEvent,
  SingletonAction,
  TitleParametersDidChangeEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import { evaluate, evaluateUrl } from "../expr";
import { describeError, isExpectedNetworkError, MIN_POLL_MS, NO_BODY, RedirectError, safeUrl, send, TooLargeError } from "../http";
import { errorIconUri, toIconDataUri } from "../image";
import { LogDeduper } from "../log-dedupe";

type Settings = {
  url?: string;
  method?: string;
  headers?: string; // one "Name: value" per line
  body?: string;
  timeout?: number; // seconds
  pollMs?: number; // 0 / empty = off (GET/HEAD only)
  jsonPath?: string; // expression: path, {template}, or =math
  iconPath?: string; // expression that yields an image: SVG markup, or an SVG/PNG/JPEG/GIF/WebP data URI
  onPress?: "refresh" | "url"; // key press: call the API (default) or open a browser URL
  openUrl?: string; // URL template for onPress = "url"; {path} values come from the response JSON
  prefix?: string; // supports \n
  suffix?: string; // supports \n
};

const MAX_TIMER_MS = 2_147_483_647; // setInterval treats anything larger as 1 ms
const SETTINGS_DEBOUNCE_MS = 600;
const MAX_TITLE = 200; // far more than a key can show; an API value can be a megabyte

function unescapeNl(t = ""): string {
  return t.replace(/\\n/g, "\n");
}

type RunResult = { ok: boolean; data?: unknown };

@action({ UUID: "io.github.tekinozbek.api-tools.call" })
export class CallWebhook extends SingletonAction<Settings> {
  private timers = new Map<string, NodeJS.Timeout>();
  private debounce = new Map<string, NodeJS.Timeout>();
  /** Current generation per key; removed when the key goes away. Late responses from older generations are dropped. */
  private gen = new Map<string, number>();
  private nextGen = 0;
  /** In-flight requests per key, aborted when the key restarts or goes away. */
  private aborts = new Map<string, AbortController>();
  private inFlight = new Set<string>(); // "<actionId>:<gen>" of poll requests in progress
  /** Keys on screen. */
  private visible = new Set<string>();
  /** Last title we set per key, so unchanged text isn't re-sent. */
  private titles = new Map<string, string>();
  /** Keys whose title must be sent even if unchanged, because Stream Deck reported a different one. */
  private stale = new Set<string>();
  /** Keys whose current settings have an Expression, to notice when it is removed. */
  private expressions = new Set<string>();
  /** Keys whose title we set while polling or showing an error, so it can be cleared when polling stops. */
  private polled = new Set<string>();
  /** Last image (data URI) we pushed per key, so unchanged icons aren't re-sent. */
  private icons = new Map<string, string>();
  /** Latest parsed response per key, used to fill the "open URL" template without another request. */
  private data = new Map<string, unknown>();
  /** Keys currently showing an error (title or error icon). */
  private errored = new Set<string>();
  /** Per-key log de-duplication, so a failing poll logs once instead of on every tick. */
  private logs = new LogDeduper({
    info: (m) => streamDeck.logger.info(m),
    warn: (m) => streamDeck.logger.warn(m),
    error: (m) => streamDeck.logger.error(m),
  });

  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    this.visible.add(ev.action.id);
    this.startPolling(ev.action as KeyAction<Settings>, ev.payload.settings);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    // The inspector saves on every edit; wait until typing settles before firing requests.
    const id = ev.action.id;
    if (!this.visible.has(id)) return; // nothing to update, and nothing would ever stop the timer
    clearTimeout(this.debounce.get(id));
    this.debounce.set(
      id,
      setTimeout(() => {
        this.debounce.delete(id);
        this.startPolling(ev.action as KeyAction<Settings>, ev.payload.settings);
      }, SETTINGS_DEBOUNCE_MS),
    );
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    const id = ev.action.id;
    this.visible.delete(id);
    this.titles.delete(id);
    this.stale.delete(id);
    this.expressions.delete(id);
    clearTimeout(this.debounce.get(id));
    this.debounce.delete(id);
    this.stopPolling(id);
    this.gen.delete(id);
    this.polled.delete(id);
    this.icons.delete(id);
    this.errored.delete(id);
    this.logs.clear(id);
  }

  /** The title on the key may no longer be ours (the user edited the Title box), so send it again next time. */
  override onTitleParametersDidChange(ev: TitleParametersDidChangeEvent<Settings>): void {
    const id = ev.action.id;
    if (this.titles.has(id) && this.titles.get(id) !== ev.payload.title) this.stale.add(id);
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const s = ev.payload.settings;
    try {
      if (s.onPress === "url") {
        // The browser opening is the feedback; only flash the alert if it failed.
        if (!(await this.openFromResponse(ev.action, s))) await ev.action.showAlert();
        return;
      }
      if (!s.url) return void (await ev.action.showAlert());
      const { ok } = await this.run(ev.action, s, false, false);
      if (ok) await ev.action.showOk();
      else await ev.action.showAlert();
    } catch (err) {
      streamDeck.logger.error("Key press failed", err);
      await ev.action.showAlert().catch(() => {});
    }
  }

  /** "Open URL" behaviour: fill the URL template from the API response and open it in the default browser. */
  private async openFromResponse(action: KeyAction<Settings>, s: Settings): Promise<boolean> {
    const id = action.id;
    // The field is multi-line (for its hint), so drop any stray line breaks.
    const template = (s.openUrl ?? "").replace(/[\r\n]+/g, "").trim();
    if (!template) {
      streamDeck.logger.warn("Button behavior is 'Open URL' but no URL is set");
      return false;
    }

    let data: unknown;
    if (template.includes("{")) {
      // While polling, the latest response is already at hand; otherwise ask the API now.
      if (this.timers.has(id) && this.data.has(id)) {
        data = this.data.get(id);
      } else {
        if (!s.url) {
          streamDeck.logger.warn("The URL template uses {values} but no API URL is set");
          return false;
        }
        const r = await this.run(action, s, false, true);
        if (!r.ok || r.data === undefined) return false;
        data = r.data;
      }
    }

    let url: string;
    try {
      url = evaluateUrl(template, data);
      const proto = new URL(url).protocol;
      if (proto !== "http:" && proto !== "https:") throw new Error(`Only http(s) URLs can be opened, not ${proto}`);
    } catch (err) {
      streamDeck.logger.warn(`Can't open URL: ${(err as Error).message}`);
      return false;
    }

    await streamDeck.system.openUrl(new URL(url).href); // the parsed form: no stray newlines or spaces
    return true;
  }

  /** Cancel the timer and any in-flight request, and invalidate older generations. */
  private stopPolling(id: string): void {
    const t = this.timers.get(id);
    if (t) clearInterval(t);
    this.timers.delete(id);
    this.aborts.get(id)?.abort();
    this.aborts.delete(id);
    this.data.delete(id);
    this.gen.set(id, ++this.nextGen);
  }

  private startPolling(action: KeyAction<Settings>, s: Settings): void {
    const id = action.id;
    this.stopPolling(id);

    const ms = Number(s.pollMs) || 0;
    const method = (s.method ?? "POST").toUpperCase();
    const pollable = !!s.url && ms > 0 && NO_BODY.has(method);

    if (ms > 0 && s.url && !pollable) {
      streamDeck.logger.warn(`Polling is only allowed for GET/HEAD, not ${method}; polling disabled`);
    }
    // No icon expression any more: go back to the default icon.
    if (!s.iconPath && this.icons.delete(id)) action.setImage().catch(() => {});

    // Remove values we left on the key that nothing will update now: polling was turned off, or the Expression removed.
    const stopped = !pollable && this.polled.delete(id);
    const removed = !s.jsonPath && this.expressions.delete(id);
    if (s.jsonPath) this.expressions.add(id);
    if (stopped || (removed && this.titles.get(id))) {
      this.errored.delete(id);
      this.setTitle(action, "").catch(() => {});
    }
    if (stopped && this.icons.delete(id)) action.setImage().catch(() => {});
    if (!pollable) return;

    const key = `${id}:${this.gen.get(id)}`;
    const tick = () => {
      if (this.inFlight.has(key)) return; // skip overlapping polls
      this.inFlight.add(key);
      this.run(action, s, true, false)
        .catch((err) => this.logs.log(id, "error", `Poll failed: ${describeError(err)}`))
        .finally(() => this.inFlight.delete(key));
    };
    tick();
    this.timers.set(id, setInterval(tick, Math.min(Math.max(ms, MIN_POLL_MS), MAX_TIMER_MS)));
  }

  /** Set the title, shortened to what a key could show, unless it is already there. */
  private async setTitle(action: KeyAction<Settings>, text: string): Promise<void> {
    const id = action.id;
    const title = text.length > MAX_TITLE ? Array.from(text.slice(0, MAX_TITLE * 2)).slice(0, MAX_TITLE).join("") : text;
    const previous = this.titles.get(id);
    if (previous === title && !this.stale.has(id)) return;
    this.stale.delete(id);
    this.titles.set(id, title);
    try {
      await action.setTitle(title);
    } catch (err) {
      if (this.titles.get(id) === title) this.titles.delete(id); // try again next time
      throw err;
    }
  }

  /**
   * Make the request and update the key. `ok` is true on success (2xx and, if anything needs the JSON, valid JSON).
   * `data` is the parsed response when it was needed. `needData` forces parsing (used by "open URL").
   */
  private async run(action: KeyAction<Settings>, s: Settings, polling: boolean, needData: boolean): Promise<RunResult> {
    const id = action.id;
    const g = this.gen.get(id);
    if (!this.visible.has(id)) return { ok: false };

    // Polls share one abortable controller per key; key presses get their own.
    const controller = new AbortController();
    if (polling) this.aborts.set(id, controller);

    const title = async (text: string) => {
      if (this.gen.get(id) !== g) return; // key changed or went away meanwhile
      try {
        await this.setTitle(action, text);
        if (polling && this.gen.has(id)) this.polled.add(id); // skip if the key went away meanwhile
      } catch (err) {
        streamDeck.logger.warn("setTitle failed", err);
      }
    };
    // Show failures on the key whenever it displays something from the API.
    const display = polling || !!s.jsonPath || !!s.iconPath;
    const fail = async (...lines: string[]): Promise<RunResult> => {
      if (this.gen.get(id) === g) this.data.delete(id);
      if (display) await this.showError(action, s, g, lines);
      return { ok: false };
    };
    const where = `${(s.method ?? "POST").toUpperCase()} ${safeUrl(s.url)}`;
    const wantData = needData || !!s.jsonPath || !!s.iconPath || (s.onPress === "url" && !!s.openUrl?.includes("{"));

    try {
      const { ok, status, text } = await send(s, controller.signal, polling);
      if (!ok) {
        this.logs.log(id, "warn", `${where} -> ${status}`);
        return await fail("HTTP", String(status));
      }

      // The request worked: clear any error we were showing.
      const wasErrored = this.gen.get(id) === g && this.errored.delete(id);

      if (wantData) {
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          this.logs.log(id, "warn", "Response is not valid JSON");
          return await fail("BAD", "JSON");
        }
        if (this.gen.get(id) === g) this.data.set(id, data);

        let good = true;
        if (s.jsonPath) {
          try {
            const v = evaluate(unescapeNl(s.jsonPath), data);
            await title(`${unescapeNl(s.prefix)}${v}${unescapeNl(s.suffix)}`);
          } catch (err) {
            this.logs.log(id, "warn", `Bad expression: ${(err as Error).message}`);
            await this.showError(action, s, g, ["ERR"]);
            good = false;
          }
        } else if (wasErrored) {
          await title(""); // nothing of ours to show; drop the error text
        }
        // After an Expression error, leave the error showing instead of drawing the icon over it.
        if (good && s.iconPath && !(await this.applyIcon(action, s, data, g))) good = false;
        if (good) this.logs.recovered(id);
        return { ok: good, data };
      }

      if (polling) await title(text.trim().slice(0, 20));
      else if (wasErrored) await title("");
      this.logs.recovered(id);
      return { ok: true };
    } catch (err) {
      if (controller.signal.aborted) return { ok: false }; // superseded; not an error
      // Expected network failures are one line (no stack); the same line repeats are collapsed per key.
      if (isExpectedNetworkError(err)) this.logs.log(id, "warn", `${where} failed: ${describeError(err)}`);
      else this.logs.log(id, "error", `${where} failed: ${(err as Error)?.stack ?? String(err)}`);
      if (err instanceof TooLargeError) return await fail("TOO", "BIG");
      if (err instanceof RedirectError) return await fail("REDIRECT");
      if ((err as Error)?.name === "TimeoutError") return await fail("TIMEOUT");
      return await fail("NO CONN");
    } finally {
      if (this.aborts.get(id) === controller) this.aborts.delete(id);
    }
  }

  /** Put an error on the key: a red error icon when the key shows an icon, otherwise the text as the title. */
  private async showError(action: KeyAction<Settings>, s: Settings, g: number | undefined, lines: string[]): Promise<void> {
    const id = action.id;
    if (this.gen.get(id) !== g) return;
    try {
      if (s.iconPath) {
        const uri = errorIconUri(lines);
        if (this.icons.get(id) !== uri) {
          await action.setImage(uri);
          if (!this.gen.has(id)) return; // key went away meanwhile; don't leave stale state behind
          this.icons.set(id, uri);
        }
        await this.setTitle(action, ""); // the text is in the icon; avoid drawing it twice
      } else {
        await this.setTitle(action, lines.join("\n"));
      }
      if (!this.gen.has(id)) return;
      this.polled.add(id);
      this.errored.add(id);
    } catch (err) {
      streamDeck.logger.warn("Showing error failed", err);
    }
  }

  /** Evaluate the icon expression and set the key image. Returns false (and shows an error icon) if the value is unusable. */
  private async applyIcon(action: KeyAction<Settings>, s: Settings, data: unknown, g: number | undefined): Promise<boolean> {
    const id = action.id;
    let value: string;
    try {
      value = evaluate(s.iconPath!, data).trim();
    } catch (err) {
      this.logs.log(id, "warn", `Bad icon expression: ${(err as Error).message}`);
      await this.showError(action, s, g, ["BAD", "ICON"]);
      return false;
    }

    const empty = value === "" || value === "n/a";
    const uri = empty ? undefined : toIconDataUri(value);
    if (!empty && !uri) {
      this.logs.log(id, "warn", "Icon value is not a usable image (not SVG/PNG/JPEG/GIF/WebP, too large, or blocked content)");
      await this.showError(action, s, g, ["BAD", "ICON"]);
      return false;
    }
    if (this.gen.get(id) !== g) return true; // key changed or went away meanwhile

    if (uri) {
      if (this.icons.get(id) === uri) return true; // unchanged
    } else if (!this.icons.has(id)) {
      return true; // already showing the default
    }

    try {
      await action.setImage(uri); // undefined restores the default icon
      if (!this.gen.has(id)) return true; // key went away meanwhile; don't leave stale state behind
      if (uri) this.icons.set(id, uri);
      else this.icons.delete(id);
    } catch (err) {
      streamDeck.logger.warn("setImage failed", err);
    }
    return true;
  }
}
