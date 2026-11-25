import streamDeck, {
  action,
  DidReceiveSettingsEvent,
  KeyAction,
  SendToPluginEvent,
  SingletonAction,
  TitleParametersDidChangeEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { ClockSettings, clockTitle, timeZoneItems } from "../clock";

/** Checked this often; the key is only updated when its text actually changes. */
const TICK_MS = 200; // short enough that seconds advance evenly

type Key = { action: KeyAction<ClockSettings>; settings: ClockSettings; title?: string };

@action({ UUID: "io.github.tekinozbek.utilities.clock" })
export class Clock extends SingletonAction<ClockSettings> {
  private keys = new Map<string, Key>();
  private timer?: NodeJS.Timeout; // one timer for all visible clocks

  override onWillAppear(ev: WillAppearEvent<ClockSettings>): void {
    const key: Key = { action: ev.action as KeyAction<ClockSettings>, settings: ev.payload.settings };
    this.keys.set(ev.action.id, key);
    key.action.setImage().catch(() => {}); // drop any image an earlier version drew
    this.migrate(key);
    this.render(key);
    this.timer ??= setInterval(() => this.keys.forEach((k) => this.render(k)), TICK_MS);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ClockSettings>): void {
    const key = this.keys.get(ev.action.id);
    if (!key) return;
    key.settings = ev.payload.settings;
    this.render(key);
  }

  /** The title on the key may no longer be ours (the user edited the Title box), so send it again on the next tick. */
  override onTitleParametersDidChange(ev: TitleParametersDidChangeEvent<ClockSettings>): void {
    const key = this.keys.get(ev.action.id);
    if (key && key.title !== ev.payload.title) key.title = undefined;
  }

  override onWillDisappear(ev: WillDisappearEvent<ClockSettings>): void {
    this.keys.delete(ev.action.id);
    if (this.keys.size === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** The inspector asks for the time zone list to fill its dropdown. */
  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, ClockSettings>): Promise<void> {
    const payload = ev.payload as { event?: string } | null;
    if (payload?.event !== "getTimeZones") return;
    await streamDeck.ui.sendToPropertyInspector({ event: "getTimeZones", items: timeZoneItems() });
  }

  /** Keys saved before "Title" became "Prefix" keep their text. */
  private migrate(key: Key): void {
    const { label, ...rest } = key.settings;
    if (label === undefined) return;
    key.settings = { ...rest, prefix: rest.prefix ?? label };
    key.action.setSettings(key.settings).catch((err) => streamDeck.logger.warn("setSettings failed", err));
  }

  private render(key: Key): void {
    const title = clockTitle(key.settings, new Date());
    if (title === key.title) return;
    key.title = title;
    key.action.setTitle(title).catch((err) => {
      key.title = undefined; // try again on the next tick
      streamDeck.logger.warn("setTitle failed", err);
    });
  }
}
