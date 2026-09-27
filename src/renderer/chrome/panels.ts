import type { AppEntry } from "../../shared/app-catalog";
import { pickerSections } from "../../shared/picker";
import type { Settings, SettingsPatch, ShortcutModifier } from "../../shared/settings";
import { normaliseModifiers, SHORTCUT_MODIFIERS } from "../../shared/shortcuts";
import type { DeviceCommand, DeviceCommandResult, DeviceSummary, MainToRenderer } from "../../shared/wire";
import { connectAddress, validHostPort, validPairingCode, type DeviceCommands } from "./device-commands";
import { el } from "./dom";
import type { Size } from "./hit-zone";
import type { ToastInput } from "./toast-queue";
import { deviceResultMessage, PAIR_INPUT_MESSAGES, type DeviceMessage } from "./toast-text";

export type PanelName = "apps" | "device" | "colour" | "settings";

export interface Panel {
  readonly node: HTMLElement;
  readonly size: Size;
  opened(): void;
  settingsChanged(settings: Settings): void;
}

function panelNode(title: string, children: (Node | string)[], extra?: Node): HTMLElement {
  return el("div", { className: "hinge-panel hinge-glass", attrs: { role: "dialog", "aria-label": title } }, [el("h2", {}, [title, extra ?? null]), ...children]);
}

export interface DevicePanelDeps {
  commands: DeviceCommands;
  toast(input: ToastInput): void;
  currentSerial(): string | null;
}

const TRANSPORT_LABEL = { usb: "USB", tcp: "Wi-Fi", mdns: "Wi-Fi (mDNS)" } as const;

export class DevicePanel implements Panel {
  readonly size = { w: 300, h: 420 };
  readonly node: HTMLElement;
  readonly #deps: DevicePanelDeps;
  readonly #list = el("div");
  readonly #status = el("div", { className: "status", attrs: { role: "status", "data-device-status": "", hidden: "" } });
  readonly #host = el("input", { attrs: { type: "text", placeholder: "192.168.1.20:37099", spellcheck: "false" } });
  readonly #code = el("input", { attrs: { type: "text", placeholder: "123456", inputmode: "numeric", maxlength: "6" } });
  readonly #port = el("input", { attrs: { type: "text", placeholder: "Connect port, e.g. 41234", inputmode: "numeric" } });
  readonly #connectRow: HTMLElement;
  #busy = false;

  constructor(deps: DevicePanelDeps) {
    this.#deps = deps;
    const pair = el("button", { className: "primary", text: "Pair", on: { click: () => this.#pair() } });
    const connect = el("button", { text: "Connect", on: { click: () => this.#connectAfterPair() } });
    this.#connectRow = el("div", { className: "field", attrs: { hidden: "" } }, [
      el("span", { className: "help", text: "Paired. The phone's Wireless debugging screen shows the IP address and port to connect to." }),
      el("div", { className: "row" }, [el("div", { className: "grow" }, [this.#port]), connect]),
    ]);
    const refresh = el("button", { text: "Refresh", on: { click: () => this.#refreshList() } });
    this.node = panelNode(
      "Devices",
      [
        this.#list,
        el("h3", { text: "Pair new device" }),
        el("span", { className: "help", text: "On the phone: Developer options, Wireless debugging, Pair device with pairing code." }),
        el("label", { className: "field" }, [el("span", { className: "sub", text: "IP address and port" }), this.#host]),
        el("label", { className: "field" }, [el("span", { className: "sub", text: "Wi-Fi pairing code" }), this.#code]),
        el("div", { className: "row" }, [el("div", { className: "grow" }), pair]),
        this.#status,
        this.#connectRow,
      ],
      refresh,
    );
  }

  opened(): void {
    this.#say(null);
    this.#refreshList();
  }

  #refreshList(): void {
    this.#list.replaceChildren(el("div", { className: "empty", text: "Looking for devices..." }));
    this.#deps.commands
      .request({ type: "list" })
      .then((result) => this.#renderList(result.type === "list" ? result.devices : []))
      .catch((e: unknown) => this.#list.replaceChildren(el("div", { className: "empty", text: `Could not list devices: ${String(e)}` })));
  }

  settingsChanged(): void {}

  /** main pushes every device-list change; an open panel shows it at once, unless a command is running and will refresh the list itself. */
  devicesChanged(devices: DeviceSummary[]): void {
    if (!this.node.isConnected || this.#busy) return;
    this.#renderList(devices);
  }

  #renderList(devices: DeviceSummary[]): void {
    if (devices.length === 0) {
      this.#list.replaceChildren(el("div", { className: "empty", text: "No devices. Plug the phone in over USB or pair it below." }));
      return;
    }
    const current = this.#deps.currentSerial();
    this.#list.replaceChildren(...devices.map((d) => this.#row(d, d.serial === current)));
  }

  #row(device: DeviceSummary, current: boolean): HTMLElement {
    const actions: HTMLElement[] = [];
    if (current) actions.push(el("span", { className: "badge", text: "current" }));
    else actions.push(this.#action("Use", { type: "connect", serial: device.serial }));
    if (device.transport === "usb") actions.push(this.#action("Wi-Fi", { type: "switch-to-wifi", serial: device.serial }, "Switch this phone to Wi-Fi debugging"));
    else actions.push(this.#action("Disconnect", { type: "disconnect", serial: device.serial }));
    const state = device.state === "device" ? "" : `, ${device.state}`;
    return el("div", { className: "row" }, [
      el("div", { className: "grow" }, [
        el("div", { className: "name", text: device.model ?? device.serial }),
        el("div", { className: "sub", text: `${TRANSPORT_LABEL[device.transport]}${state} · ${device.serial}` }),
      ]),
      ...actions,
    ]);
  }

  #action(label: string, command: DeviceCommand, title?: string): HTMLButtonElement {
    return el("button", { text: label, title, on: { click: () => void this.#run(command) } });
  }

  /** Toasts sit above the panel too, but a message about the form belongs next to it. */
  #say(message: DeviceMessage | null): void {
    this.#status.hidden = message === null;
    this.#status.textContent = message?.text ?? "";
    this.#status.classList.toggle("error", message?.tone === "error");
  }

  async #run(command: DeviceCommand): Promise<DeviceCommandResult | null> {
    if (this.#busy) return null;
    this.#busy = true;
    this.node.setAttribute("aria-busy", "true");
    this.#say({ text: "Working...", tone: "info" });
    try {
      const result = await this.#deps.commands.request(command);
      const message = deviceResultMessage(result);
      this.#say(message);
      if (message?.tone === "info") this.#deps.toast(message);
      return result;
    } catch (e) {
      this.#say({ text: String(e).replace(/^Error:\s*/, ""), tone: "error" });
      return null;
    } finally {
      this.#busy = false;
      this.node.removeAttribute("aria-busy");
      this.#refreshList();
    }
  }

  async #pair(): Promise<void> {
    const hostPort = this.#host.value.trim();
    const code = this.#code.value.trim();
    if (!validHostPort(hostPort)) return this.#say(PAIR_INPUT_MESSAGES.hostPort);
    if (!validPairingCode(code)) return this.#say(PAIR_INPUT_MESSAGES.code);
    this.#connectRow.hidden = true;
    const result = await this.#run({ type: "pair", hostPort, code });
    if (result?.type === "pair" && result.ok && !result.connectedAddress) this.#connectRow.hidden = false;
    if (result?.type === "pair" && result.ok) this.#code.value = "";
  }

  async #connectAfterPair(): Promise<void> {
    const address = connectAddress(this.#host.value, this.#port.value);
    if (!address) return this.#say(PAIR_INPUT_MESSAGES.connectPort);
    const result = await this.#run({ type: "connect", serial: address });
    if (result?.type === "connect" && result.ok) this.#connectRow.hidden = true;
  }
}

export interface ColourPanelDeps {
  swatches: { id: string; label: string; swatch: string }[];
  save(patch: SettingsPatch): void;
}

export class ColourPanel implements Panel {
  readonly size = { w: 240, h: 196 };
  readonly node: HTMLElement;
  readonly #buttons = new Map<string, HTMLButtonElement>();

  constructor(deps: ColourPanelDeps) {
    const grid = el("div", { className: "hinge-swatches" });
    for (const swatch of deps.swatches) {
      const dot = el("span", { className: "dot" });
      dot.style.background = swatch.swatch;
      const button = el("button", { attrs: { "aria-pressed": "false", "data-colourway": swatch.id }, on: { click: () => deps.save({ colourway: swatch.id }) } }, [dot, swatch.label]);
      this.#buttons.set(swatch.id, button);
      grid.append(button);
    }
    this.node = panelNode("Colour", [grid]);
  }

  opened(): void {}

  settingsChanged(settings: Settings): void {
    for (const [id, button] of this.#buttons) button.setAttribute("aria-pressed", String(id.toLowerCase() === settings.colourway.toLowerCase()));
  }
}

export interface SettingsPanelDeps {
  save(patch: SettingsPatch): void;
  settingsPath(): Promise<string>;
}

const MODIFIER_LABELS: Record<ShortcutModifier, string> = {
  lalt: "Left Alt",
  ralt: "Right Alt",
  lsuper: "Left Super",
  rsuper: "Right Super",
  lctrl: "Left Ctrl",
  rctrl: "Right Ctrl",
};

type NumericSetting = "videoBitRate" | "maxSize" | "maxFps" | "scrollSmoothing" | "scrollSpeed";

const NUMERIC_CHOICES: Record<NumericSetting, [number, string][]> = {
  videoBitRate: [4, 8, 16, 24, 32, 48].map((m) => [m * 1_000_000, `${m} Mbps`]),
  maxSize: [[0, "Full resolution"], [2520, "2520 px"], [1920, "1920 px"], [1600, "1600 px"], [1280, "1280 px"], [1024, "1024 px"]],
  maxFps: [[0, "No limit"], [30, "30 fps"], [60, "60 fps"], [90, "90 fps"], [120, "120 fps"]],
  scrollSmoothing: [[0, "Off"], [80, "Short"], [150, "Medium"], [250, "Long"]],
  scrollSpeed: [0.5, 0.75, 1, 1.5, 2].map((s) => [s, `${s}x`]),
};

export class SettingsPanel implements Panel {
  readonly size = { w: 300, h: 540 };
  readonly node: HTMLElement;
  readonly #deps: SettingsPanelDeps;
  readonly #modifiers = new Map<ShortcutModifier, HTMLInputElement>();
  readonly #audio = el("input", { attrs: { type: "checkbox" } });
  readonly #mirrorNotifications = el("input", { attrs: { type: "checkbox" } });
  readonly #codec = el("select", {}, [el("option", { text: "H.264", attrs: { value: "h264" } }), el("option", { text: "H.265", attrs: { value: "h265" } })]);
  readonly #wheelStyle = el("select", {}, [
    el("option", { text: "Finger swipe", attrs: { value: "swipe" } }),
    el("option", { text: "Scroll steps", attrs: { value: "events" } }),
  ]);
  readonly #numeric = new Map<NumericSetting, HTMLSelectElement>();
  readonly #path = el("div", { className: "path" });
  #settings: Settings | null = null;

  constructor(deps: SettingsPanelDeps) {
    this.#deps = deps;
    const modifierGrid = el("div", { className: "grid" });
    for (const modifier of SHORTCUT_MODIFIERS) {
      const box = el("input", { attrs: { type: "checkbox" }, on: { change: () => this.#saveModifiers() } });
      this.#modifiers.set(modifier, box);
      modifierGrid.append(el("label", { className: "check" }, [box, MODIFIER_LABELS[modifier]]));
    }
    this.#audio.addEventListener("change", () => deps.save({ audio: this.#audio.checked }));
    this.#mirrorNotifications.addEventListener("change", () => deps.save({ mirrorNotifications: this.#mirrorNotifications.checked }));
    this.#codec.addEventListener("change", () => deps.save({ videoCodec: this.#codec.value as Settings["videoCodec"] }));
    this.#wheelStyle.addEventListener("change", () => deps.save({ wheelStyle: this.#wheelStyle.value as Settings["wheelStyle"] }));
    const numericFields = (Object.keys(NUMERIC_CHOICES) as NumericSetting[]).map((key) => {
      const select = el("select", {}, NUMERIC_CHOICES[key].map(([value, label]) => el("option", { text: label, attrs: { value: String(value) } })));
      select.addEventListener("change", () => deps.save({ [key]: Number(select.value) }));
      this.#numeric.set(key, select);
      return select;
    });
    const [bitRate, maxSize, maxFps, scrollSmoothing, scrollSpeed] = numericFields;
    this.node = panelNode("Settings", [
      el("h3", { text: "Shortcut key (MOD)" }),
      modifierGrid,
      el("h3", { text: "Notifications" }),
      el("label", { className: "check" }, [this.#mirrorNotifications, "Mirror phone notifications and calls"]),
      el("h3", { text: "Stream" }),
      el("label", { className: "check" }, [this.#audio, "Play phone audio on this PC"]),
      el("div", { className: "grid" }, [
        el("label", { className: "field" }, [el("span", { className: "sub", text: "Codec" }), this.#codec]),
        el("label", { className: "field" }, [el("span", { className: "sub", text: "Bit rate" }), bitRate]),
        el("label", { className: "field" }, [el("span", { className: "sub", text: "Max size" }), maxSize]),
        el("label", { className: "field" }, [el("span", { className: "sub", text: "Max frame rate" }), maxFps]),
      ]),
      el("p", { className: "note", text: "Stream changes apply the next time the phone connects." }),
      el("h3", { text: "Mouse wheel" }),
      el("div", { className: "grid" }, [
        el("label", { className: "field" }, [el("span", { className: "sub", text: "Scrolls with" }), this.#wheelStyle]),
        el("label", { className: "field" }, [el("span", { className: "sub", text: "Speed" }), scrollSpeed]),
        el("label", { className: "field" }, [el("span", { className: "sub", text: "Step smoothing" }), scrollSmoothing]),
      ]),
      el("p", { className: "note", text: "A finger swipe glides on like a flick on the phone. Scroll steps suit apps that ignore swipes; a touchpad always scrolls in steps." }),
      el("h3", { text: "Settings file" }),
      this.#path,
    ]);
  }

  opened(): void {
    void this.#deps.settingsPath().then((path) => (this.#path.textContent = path));
  }

  settingsChanged(settings: Settings): void {
    this.#settings = settings;
    const held = normaliseModifiers(settings.shortcutModifiers);
    for (const [modifier, box] of this.#modifiers) box.checked = held.includes(modifier);
    this.#audio.checked = settings.audio;
    this.#mirrorNotifications.checked = settings.mirrorNotifications;
    this.#codec.value = settings.videoCodec;
    this.#wheelStyle.value = settings.wheelStyle;
    for (const [key, select] of this.#numeric) {
      const value = String(settings[key]);
      if (![...select.options].some((o) => o.value === value)) select.append(el("option", { text: value, attrs: { value } }));
      select.value = value;
      select.disabled = key === "scrollSmoothing" && settings.wheelStyle === "swipe";
    }
  }

  /** At least one modifier must stay ticked, or no shortcut (MOD+q to quit included) could be pressed. */
  #saveModifiers(): void {
    const picked = SHORTCUT_MODIFIERS.filter((m) => this.#modifiers.get(m)?.checked);
    if (picked.length === 0) {
      if (this.#settings) this.settingsChanged(this.#settings);
      return;
    }
    this.#deps.save({ shortcutModifiers: [...picked] });
  }
}

export type AppsListing = Omit<Extract<MainToRenderer, { kind: "apps" }>, "kind">;

export interface PickerPanelDeps {
  requestApps(): void;
  popOut(pkg: string): void;
  createShortcut(pkg: string): void;
}

export class PickerPanel implements Panel {
  readonly size = { w: 340, h: 480 };
  readonly node: HTMLElement;
  readonly #deps: PickerPanelDeps;
  readonly #search = el("input", { attrs: { type: "text", placeholder: "Search apps", "aria-label": "Search apps", spellcheck: "false" } });
  readonly #error = el("div", { className: "status error", attrs: { role: "status", "data-picker-error": "", hidden: "" } });
  readonly #body = el("div");
  #listing: AppsListing | null = null;

  constructor(deps: PickerPanelDeps) {
    this.#deps = deps;
    this.#search.addEventListener("input", () => this.#render());
    this.#search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const first = this.#listing && pickerSections(this.#listing.apps, this.#listing.recents, this.#search.value).all[0];
      if (first) deps.popOut(first.pkg);
    });
    const refresh = el("button", { text: "Refresh", on: { click: () => this.#request() } });
    this.node = panelNode("Apps", [this.#search, this.#error, this.#body], refresh);
  }

  opened(): void {
    this.#search.value = "";
    this.#request();
    this.#search.focus();
  }

  settingsChanged(): void {}

  listed(listing: AppsListing): void {
    this.#listing = listing;
    this.#render();
  }

  #request(): void {
    this.#listing = null;
    this.#render();
    this.#deps.requestApps();
  }

  #render(): void {
    const listing = this.#listing;
    this.#error.hidden = !listing?.error;
    this.#error.textContent = listing?.error ?? "";
    if (!listing) {
      this.node.setAttribute("aria-busy", "true");
      this.#body.replaceChildren(el("div", { className: "empty", text: "Loading apps..." }));
      return;
    }
    this.node.removeAttribute("aria-busy");
    const { recents, all } = pickerSections(listing.apps, listing.recents, this.#search.value);
    const sections: HTMLElement[] = [];
    if (recents.length > 0) sections.push(el("h3", { text: "Recent" }), this.#grid(recents, listing.icons));
    if (all.length > 0) sections.push(el("h3", { text: "All apps" }), this.#grid(all, listing.icons));
    else if (listing.apps.length > 0) sections.push(el("div", { className: "empty", text: "No apps match" }));
    else if (!listing.error) sections.push(el("div", { className: "empty", text: "No apps found on the phone" }));
    this.#body.replaceChildren(...sections);
  }

  #grid(apps: AppEntry[], icons: Record<string, string>): HTMLElement {
    return el("div", { className: "hinge-apps" }, apps.map((app) => this.#tile(app, icons[app.pkg])));
  }

  #tile(app: AppEntry, icon: string | undefined): HTMLElement {
    const glyph = icon
      ? el("img", { className: "icon", attrs: { src: icon, alt: "", draggable: "false" } })
      : el("span", { className: "icon letter", text: (app.label.trim()[0] ?? "?").toUpperCase(), attrs: { "aria-hidden": "true" } });
    const open = el("button", { className: "open", title: `Open ${app.label} in its own window`, attrs: { "data-app": app.pkg }, on: { click: () => this.#deps.popOut(app.pkg) } }, [
      glyph,
      el("span", { className: "label", text: app.label }),
    ]);
    const shortcut = el("button", { className: "shortcut", text: "Shortcut", title: `Create a desktop shortcut for ${app.label}`, on: { click: () => this.#deps.createShortcut(app.pkg) } });
    return el("div", { className: "tile" }, [open, shortcut]);
  }
}
