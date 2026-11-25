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
import { evaluate } from "../expr";
import { describeError, isExpectedNetworkError, MIN_POLL_MS, RedirectError, safeUrl, send, TooLargeError } from "../http";
import { IconFileCache } from "../icon-file";
import { toIconDataUri } from "../image";
import { LogDeduper } from "../log-dedupe";
import { iconSpec, parseState, pressRequest, statusRequest, ToggleSettings, usesResponseIcon } from "../toggle";

const MAX_TIMER_MS = 2_147_483_647; // setInterval treats anything larger as 1 ms
const SETTINGS_DEBOUNCE_MS = 600;
const DEFAULT_POLL_MS = 1000;

/**
 * Images for the "unknown" and "error" displays; the two normal states use the manifest images. Stream Deck loads
 * them by path: the plugin must not read shipped files itself, which Marketplace DRM may protect.
 */
const stateImage = (name: "unknown" | "error") => `imgs/actions/toggle/${name}@2x.png`;

type Shown = "on" | "off" | "unknown" | "error";

@action({ UUID: "io.github.tekinozbek.api-tools.toggle" })
export class ApiToggle extends SingletonAction<ToggleSettings> {
  /**
   * Keys on screen, each with a number for that appearance. Stream Deck doesn't wait for a handler to finish, so
   * anything resumed after an await must check that its key is still the same one.
   */
  private visible = new Map<string, number>();
  private nextAppearance = 0;
  /** The status settings `known` belongs to, per key. */
  private statusOf = new Map<string, string>();
  /** The settings polling currently uses, per key. */
  private settings = new Map<string, ToggleSettings>();
  private timers = new Map<string, NodeJS.Timeout>();
  private debounce = new Map<string, NodeJS.Timeout>();
  /** Current generation per key; late responses from older generations are dropped. */
  private gen = new Map<string, number>();
  private nextGen = 0;
  private aborts = new Map<string, AbortController>();
  private inFlight = new Set<string>(); // keys with a poll in progress
  /** Keys whose press request is running: polling is paused and extra presses are ignored. */
  private busy = new Set<string>();
  /** Last state the API reported per key (kept through errors; used to pick On or Off on press). */
  private known = new Map<string, boolean>();
  /** What the key currently shows, so unchanged displays aren't re-sent. */
  private shown = new Map<string, string>();
  private files = new IconFileCache();
  private logs = new LogDeduper({
    info: (m) => streamDeck.logger.info(m),
    warn: (m) => streamDeck.logger.warn(m),
    error: (m) => streamDeck.logger.error(m),
  });

  override async onWillAppear(ev: WillAppearEvent<ToggleSettings>): Promise<void> {
    const id = ev.action.id;
    const appearance = ++this.nextAppearance;
    this.visible.set(id, appearance);
    // Show "unknown" first so a fast first poll can't be overwritten by it.
    await this.show(ev.action as KeyAction<ToggleSettings>, "unknown");
    if (this.visible.get(id) !== appearance) return; // gone (or replaced) while we waited
    this.startPolling(ev.action as KeyAction<ToggleSettings>, ev.payload.settings);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ToggleSettings>): void {
    const id = ev.action.id;
    if (!this.visible.has(id)) return; // nothing to update, and nothing would ever stop the timer
    clearTimeout(this.debounce.get(id));
    this.debounce.set(
      id,
      setTimeout(() => {
        this.debounce.delete(id);
        this.startPolling(ev.action as KeyAction<ToggleSettings>, ev.payload.settings);
      }, SETTINGS_DEBOUNCE_MS),
    );
  }

  override onWillDisappear(ev: WillDisappearEvent<ToggleSettings>): void {
    const id = ev.action.id;
    this.visible.delete(id);
    this.statusOf.delete(id);
    this.settings.delete(id);
    clearTimeout(this.debounce.get(id));
    this.debounce.delete(id);
    this.stopPolling(id);
    this.gen.delete(id);
    this.busy.delete(id);
    this.known.delete(id);
    this.shown.delete(id);
    this.logs.clear(id);
  }

  /** The title on the key may no longer be ours (the user edited the Title box), so draw again on the next poll. */
  override onTitleParametersDidChange(ev: TitleParametersDidChangeEvent<ToggleSettings>): void {
    const sig = this.shown.get(ev.action.id);
    if (sig !== undefined && sig.split("|")[1] !== ev.payload.title) this.shown.delete(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent<ToggleSettings>): Promise<void> {
    const act = ev.action as KeyAction<ToggleSettings>;
    const id = act.id;
    const s = ev.payload.settings;
    if (this.busy.has(id)) return; // a press is already being sent
    const appearance = this.visible.get(id);
    const gone = () => appearance === undefined || this.visible.get(id) !== appearance;

    const current = this.known.get(id);
    try {
      // The key never flips itself (DisableAutomaticStates); put it back in case Stream Deck did anyway.
      if (current !== undefined) await act.setState(current ? 1 : 0);

      if (current === undefined) {
        this.logs.log(id, "warn", "Pressed before the state is known; not sending anything");
        return void (await act.showAlert());
      }
      const req = pressRequest(s, current);
      if (!req.url) {
        this.logs.log(id, "warn", `No ${current ? "Off" : "On"} URL is set`);
        return void (await act.showAlert());
      }

      // Pause polling while the press is in flight; a poll that raced ahead of it would show stale state.
      this.busy.add(id);
      this.aborts.get(id)?.abort();
      this.inFlight.delete(id);
      const where = `${(req.method ?? "POST").toUpperCase()} ${safeUrl(req.url)}`;
      let ok = false;
      try {
        const res = await send(req, new AbortController().signal, false);
        ok = res.ok;
        if (!ok) this.logs.log(id, "warn", `${where} -> ${res.status}`);
        else this.logs.recovered(id);
      } catch (err) {
        if (isExpectedNetworkError(err)) this.logs.log(id, "warn", `${where} failed: ${describeError(err)}`);
        else this.logs.log(id, "error", `${where} failed: ${(err as Error)?.stack ?? String(err)}`);
      }
      if (gone()) return; // the key left during the request; its state was already dropped
      this.busy.delete(id);

      if (ok) await act.showOk();
      else await act.showAlert();
      // Show what the API says now, not what we expect. Use the settings in force now: they may have changed during
      // the press, and the poll that change started was skipped because the press was still running.
      if (!gone()) await this.pollOnce(act, this.settings.get(id) ?? s);
    } catch (err) {
      if (!gone()) this.busy.delete(id);
      streamDeck.logger.error("Key press failed", err);
      await act.showAlert().catch(() => {});
    }
  }

  private stopPolling(id: string): void {
    const t = this.timers.get(id);
    if (t) clearInterval(t);
    this.timers.delete(id);
    this.aborts.get(id)?.abort();
    this.aborts.delete(id);
    this.inFlight.delete(id);
    this.gen.set(id, ++this.nextGen);
  }

  private startPolling(act: KeyAction<ToggleSettings>, s: ToggleSettings): void {
    const id = act.id;
    this.stopPolling(id);
    this.settings.set(id, s);

    // A state learned from other status settings says nothing about these.
    const status = JSON.stringify([s.statusUrl, s.statusHeaders, s.stateExpr, s.onWhen]);
    if (this.statusOf.get(id) !== status) this.known.delete(id);
    this.statusOf.set(id, status);

    if (!s.statusUrl) {
      this.logs.log(id, "warn", "No status URL is set");
      this.known.delete(id);
      this.show(act, "unknown").catch(() => {});
      return;
    }
    const ms = Math.min(Math.max(Number(s.pollMs) || DEFAULT_POLL_MS, MIN_POLL_MS), MAX_TIMER_MS);
    const tick = () => void this.pollOnce(act, s);
    tick();
    this.timers.set(id, setInterval(tick, ms));
  }

  /** One status request; updates the key unless superseded. Never throws. */
  private async pollOnce(act: KeyAction<ToggleSettings>, s: ToggleSettings): Promise<void> {
    const id = act.id;
    const g = this.gen.get(id);
    if (g === undefined || !s.statusUrl || this.busy.has(id) || this.inFlight.has(id)) return;
    const controller = new AbortController();
    this.inFlight.add(id);
    this.aborts.set(id, controller);
    const req = statusRequest(s);
    const where = `GET ${safeUrl(s.statusUrl)}`;
    const current = () => this.gen.get(id) === g && !controller.signal.aborted;

    try {
      const { ok, status, text } = await send(req, controller.signal, true);
      if (!current()) return;
      if (!ok) {
        this.logs.log(id, "warn", `${where} -> ${status}`);
        return await this.fail(act, g, ["HTTP", String(status)]);
      }

      const hasExpr = !!s.stateExpr?.trim();
      let data: unknown;
      let haveData = false;
      if (hasExpr || usesResponseIcon(s)) {
        try {
          data = JSON.parse(text);
          haveData = true;
        } catch {
          // Only fatal when the state itself needs the JSON; a response icon just falls back to the default.
          if (hasExpr) {
            this.logs.log(id, "warn", "Response is not valid JSON");
            return await this.fail(act, g, ["BAD", "JSON"]);
          }
        }
      }

      let value: string;
      if (s.stateExpr?.trim()) {
        try {
          value = evaluate(s.stateExpr, data);
        } catch (err) {
          this.logs.log(id, "warn", `Bad expression: ${(err as Error).message}`);
          return await this.fail(act, g, ["ERR"]);
        }
      } else {
        value = text; // no expression: the response text itself is the state
      }

      const state = parseState(value, s.onWhen);
      if (state === undefined) {
        this.logs.log(id, "warn", "The state expression produced no value");
        return await this.fail(act, g, ["NO", "VALUE"]);
      }
      if (!current()) return;
      this.known.set(id, state);
      this.logs.recovered(id);
      const which = state ? "on" : "off";
      await this.show(act, which, "", this.customIcon(id, s, which, haveData, data));
    } catch (err) {
      if (controller.signal.aborted || this.gen.get(id) !== g) return; // superseded; not an error
      if (isExpectedNetworkError(err)) this.logs.log(id, "warn", `${where} failed: ${describeError(err)}`);
      else this.logs.log(id, "error", `${where} failed: ${(err as Error)?.stack ?? String(err)}`);
      if (err instanceof TooLargeError) return await this.fail(act, g, ["TOO", "BIG"]);
      if (err instanceof RedirectError) return await this.fail(act, g, ["REDIRECT"]);
      if ((err as Error)?.name === "TimeoutError") return await this.fail(act, g, ["TIMEOUT"]);
      return await this.fail(act, g, ["NO CONN"]);
    } finally {
      // Only our own entries: a newer generation may have a poll of its own in flight.
      if (this.aborts.get(id) === controller) {
        this.aborts.delete(id);
        this.inFlight.delete(id);
      }
    }
  }

  /**
   * The user's own icon for this state, or undefined to use the built-in one. A problem (missing file, bad
   * expression, unusable image) falls back to the built-in icon and is logged once, so the key stays usable.
   */
  private customIcon(id: string, s: ToggleSettings, state: "on" | "off", haveData: boolean, data: unknown): string | undefined {
    const { source, value } = iconSpec(s, state);
    if (source === "default") return undefined;
    const label = `${state === "on" ? "On" : "Off"} icon`;

    if (source === "file") {
      const r = this.files.get(value);
      if ("uri" in r) return r.uri;
      this.logs.once(id, "warn", `${label}: ${r.error}`);
      return undefined;
    }

    if (!haveData) {
      this.logs.once(id, "warn", `${label}: the response is not JSON`);
      return undefined;
    }
    let out: string;
    try {
      out = evaluate(value, data).trim();
    } catch (err) {
      this.logs.once(id, "warn", `${label}: bad expression: ${(err as Error).message}`);
      return undefined;
    }
    if (out === "" || out === "n/a") return undefined; // nothing there: built-in icon
    const uri = toIconDataUri(out);
    if (!uri) this.logs.once(id, "warn", `${label}: the value is not a usable image (not SVG/PNG/JPEG/GIF/WebP, too large, or blocked content)`);
    return uri;
  }

  private async fail(act: KeyAction<ToggleSettings>, g: number, lines: string[]): Promise<void> {
    if (this.gen.get(act.id) !== g) return;
    await this.show(act, "error", lines.join("\n"));
  }

  /** Update the key to a display. Unchanged displays are not re-sent. */
  private async show(act: KeyAction<ToggleSettings>, what: Shown, title = "", custom?: string): Promise<void> {
    const id = act.id;
    const sig = `${what}|${title}|${custom ?? ""}`;
    const appearance = this.visible.get(id);
    if (appearance === undefined || this.shown.get(id) === sig) return;
    try {
      if (what === "on" || what === "off") {
        await act.setImage(); // drop the unknown/error image (and any earlier custom icon) on both states
        const state = what === "on" ? 1 : 0;
        await act.setState(state);
        if (custom) await act.setImage(custom, { state });
      } else {
        await act.setImage(stateImage(what));
      }
      await act.setTitle(title);
      if (this.visible.get(id) === appearance) this.shown.set(id, sig);
    } catch (err) {
      streamDeck.logger.warn("Updating the key failed", err);
    }
  }
}
