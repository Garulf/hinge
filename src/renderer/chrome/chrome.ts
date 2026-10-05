import type { PickerListing } from "../../shared/picker";
import type { Settings, SettingsPatch } from "../../shared/settings";
import type { HingeAction } from "../../shared/shortcuts";
import type { DeviceSummary } from "../../shared/wire";
import type { DeviceCommands } from "./device-commands";
import { el, place, svgIcon } from "./dom";
import { MenuVisibility, panelBox, pillHeightPx, sizeForPanel, type Box, type Size } from "./hit-zone";
import { ICONS, type IconName } from "./icons";
import { ColourPanel, DevicePanel, PickerPanel, SettingsPanel, type Panel, type PanelName } from "./panels";
import { CHROME_CSS } from "./styles";
import { ToastQueue, type Toast, type ToastInput } from "./toast-queue";

export interface ChromeLayout {
  window: Size;
  /** Where the phone body is in the window right now. */
  body: Box;
  pxPerMm: number;
  /** Depth of the bezel along the phone's top edge, where the menu lives. */
  bezelPx: number;
}

export interface ChromeDeps {
  commands: DeviceCommands;
  swatches: { id: string; label: string; swatch: string }[];
  save(patch: SettingsPatch): void;
  settingsPath(): Promise<string>;
  onAction(action: HingeAction): void;
  currentSerial(): string | null;
  requestApps(id: number): void;
  popOut(pkg: string): void;
  createShortcut(pkg: string): void;
}

const MENU_BUTTONS = 9;
const MENU_GAP_PX = 2;
const MENU_PAD_PX = 1;
const PANEL_GAP_PX = 6;
const TOAST_GAP_PX = 8;

function menuWidth(pill: number): number {
  const button = pill - 4;
  return MENU_BUTTONS * button + (MENU_BUTTONS - 1) * MENU_GAP_PX + 2 * MENU_PAD_PX + 2;
}

type MenuButton = { name: IconName; title: string; press: () => void };

/**
 * The window's own controls, drawn as plain DOM over the WebGL canvas: the
 * hover menu along the phone's top edge, the panels it opens, toasts under
 * the top bezel and the FPS counter on the bottom bezel. Everything is laid
 * out from where the scene says the phone body is, every frame.
 */
export class Chrome {
  readonly root: HTMLElement;
  readonly #deps: ChromeDeps;
  readonly #menu: HTMLElement;
  readonly #buttons = new Map<IconName, HTMLButtonElement>();
  readonly #toastsNode: HTMLElement;
  readonly #toastNodes = new Map<string, HTMLElement>();
  readonly #fps = el("div", { className: "hinge-fps", attrs: { hidden: "" } });
  readonly #queue = new ToastQueue();
  readonly #visibility = new MenuVisibility();
  readonly #panels: Record<PanelName, Panel>;
  readonly #devicePanel: DevicePanel;
  readonly #pickerPanel: PickerPanel;
  #open: PanelName | null = null;
  #layout: ChromeLayout | null = null;
  #pointer: { x: number; y: number } | null = null;
  #overChrome = false;
  #settings: Settings | null = null;
  #pill = 0;
  #shown = false;
  #panelMaxHeight = "";
  #toastsKey = "";
  #swallowEscapeUp = false;

  constructor(parent: HTMLElement, deps: ChromeDeps) {
    this.#deps = deps;
    parent.append(el("style", { text: CHROME_CSS }));
    const menuButtons: MenuButton[] = [
      { name: "apps", title: "Apps", press: () => this.#toggle("apps") },
      { name: "popout", title: "Pop out this app (MOD+t)", press: () => deps.onAction("popout-current") },
      { name: "unlock", title: "Unlock the phone (MOD+l)", press: () => deps.onAction("unlock") },
      { name: "device", title: "Devices", press: () => this.#toggle("device") },
      { name: "center", title: "Center (MOD+d)", press: () => deps.onAction("center") },
      { name: "colour", title: "Colour", press: () => this.#toggle("colour") },
      { name: "pin", title: "Always on top", press: () => deps.save({ alwaysOnTop: !this.#settings?.alwaysOnTop }) },
      { name: "settings", title: "Settings", press: () => this.#toggle("settings") },
      { name: "close", title: "Quit (MOD+q)", press: () => deps.onAction("close") },
    ];
    this.#menu = el("div", { className: "hinge-menu hinge-glass", attrs: { role: "toolbar", "data-menu": "" } });
    for (const button of menuButtons) {
      const node = el("button", { className: button.name, title: button.title, attrs: { "data-button": button.name }, on: { click: button.press } }, [svgIcon(ICONS[button.name])]);
      this.#buttons.set(button.name, node);
      this.#menu.append(node);
    }
    this.#toastsNode = el("div", { className: "hinge-toasts", attrs: { "aria-live": "polite" } });
    this.#devicePanel = new DevicePanel({ commands: deps.commands, toast: (t) => this.toast(t), currentSerial: deps.currentSerial });
    this.#pickerPanel = new PickerPanel({
      requestApps: deps.requestApps,
      popOut: (pkg) => {
        deps.popOut(pkg);
        this.#setOpen(null);
      },
      createShortcut: deps.createShortcut,
    });
    this.#panels = {
      apps: this.#pickerPanel,
      device: this.#devicePanel,
      colour: new ColourPanel({ swatches: deps.swatches, save: deps.save }),
      settings: new SettingsPanel({ save: deps.save, settingsPath: deps.settingsPath }),
    };
    this.root = el("div", { attrs: { "data-chrome": "" } }, [this.#toastsNode, this.#fps, this.#menu]);
    parent.append(this.root);
    this.#listen();
  }

  toast(input: ToastInput): void {
    this.#queue.show(input, performance.now());
  }

  devicesChanged(devices: DeviceSummary[]): void {
    this.#devicePanel.devicesChanged(devices);
  }

  appsListed(listing: PickerListing): void {
    this.#pickerPanel.listed(listing);
  }

  openPicker(): void {
    this.#setOpen("apps");
  }

  settingsChanged(settings: Settings): void {
    this.#settings = settings;
    this.#buttons.get("pin")?.setAttribute("aria-pressed", String(settings.alwaysOnTop));
    this.#buttons.get("close")?.setAttribute("title", settings.closeToTray ? "Close to tray (MOD+q quits)" : "Quit (MOD+q)");
    for (const panel of Object.values(this.#panels)) panel.settingsChanged(settings);
  }

  setFps(text: string | null): void {
    this.#fps.hidden = text === null;
    this.#fps.textContent = text ?? "";
  }

  /** The window size an open panel needs, for the window to grow to while it is open. */
  neededWindow(): Size | null {
    return this.#open ? sizeForPanel(this.#panels[this.#open].size, this.#menuBottom() + PANEL_GAP_PX) : null;
  }

  closePanel(): void {
    this.#setOpen(null);
  }

  update(layout: ChromeLayout, nowMs: number): void {
    this.#layout = layout;
    const { body } = layout;
    this.#visibility.pointer(this.#pointer, body, this.#overChrome, nowMs, layout.bezelPx);
    const pill = pillHeightPx(layout.bezelPx);
    if (pill !== this.#pill) {
      this.#pill = pill;
      this.#menu.style.setProperty("--pill", `${pill}px`);
    }
    const menuTop = body.y + Math.max(0, (layout.bezelPx - pill) / 2);
    const shown = this.#visibility.visible(nowMs, this.#open !== null);
    if (shown !== this.#shown) {
      this.#shown = shown;
      this.#menu.classList.toggle("shown", shown);
    }
    place(this.#menu, { x: body.x + (body.w - menuWidth(pill)) / 2, y: menuTop });

    if (this.#open) {
      const panel = this.#panels[this.#open];
      const box = panelBox(body, layout.window, panel.size, menuTop + pill + PANEL_GAP_PX);
      place(panel.node, box);
      const maxHeight = `${Math.max(120, layout.window.h - box.y - 8)}px`;
      if (maxHeight !== this.#panelMaxHeight) {
        this.#panelMaxHeight = maxHeight;
        panel.node.style.maxHeight = maxHeight;
      }
    }

    const toastTop = body.y + Math.max(layout.bezelPx, pill) + TOAST_GAP_PX;
    place(this.#toastsNode, { x: body.x + 12, y: toastTop, w: Math.max(80, body.w - 24) });
    this.#renderToasts(this.#queue.visible(nowMs));

    place(this.#fps, { x: body.x + body.w / 2, y: body.y + body.h - 3 });
  }

  #renderToasts(toasts: Toast[]): void {
    const key = toasts.map((t) => `${t.id}\u0000${t.text}\u0000${t.tone}\u0000${t.progress}`).join("\u0001");
    if (key === this.#toastsKey) return;
    this.#toastsKey = key;
    const live = new Set(toasts.map((t) => t.id));
    for (const [id, node] of this.#toastNodes) {
      if (!live.has(id)) {
        node.remove();
        this.#toastNodes.delete(id);
      }
    }
    for (const toast of toasts) {
      let node = this.#toastNodes.get(toast.id);
      if (!node) {
        node = el("div", { className: "hinge-toast hinge-glass" }, [el("span"), el("div", { className: "bar" })]);
        this.#toastNodes.set(toast.id, node);
        this.#toastsNode.append(node);
      }
      node.classList.toggle("error", toast.tone === "error");
      const [label, bar] = node.children as unknown as [HTMLElement, HTMLElement];
      if (label.textContent !== toast.text) label.textContent = toast.text;
      bar.hidden = toast.progress === null;
      bar.style.width = `${Math.round((toast.progress ?? 0) * 100)}%`;
    }
  }

  /** Relative to the body's top edge. */
  #menuBottom(): number {
    const bezel = this.#layout?.bezelPx ?? this.#pill;
    return Math.max(bezel, this.#pill);
  }

  #toggle(name: PanelName): void {
    this.#setOpen(this.#open === name ? null : name);
  }

  #setOpen(name: PanelName | null): void {
    if (this.#open === name) return;
    if (this.#open) this.#panels[this.#open].node.remove();
    this.#open = name;
    this.#panelMaxHeight = "";
    for (const panelName of ["apps", "device", "colour", "settings"] as const) this.#buttons.get(panelName)?.setAttribute("aria-pressed", String(panelName === name));
    if (!name) return;
    const panel = this.#panels[name];
    if (this.#settings) panel.settingsChanged(this.#settings);
    this.root.append(panel.node);
    panel.opened();
    if (this.#layout) this.update(this.#layout, performance.now());
  }

  #insideChrome(target: EventTarget | null): boolean {
    return target instanceof Node && (this.#menu.contains(target) || (this.#open !== null && this.#panels[this.#open].node.contains(target)));
  }

  #listen(): void {
    window.addEventListener("pointermove", (e) => {
      this.#pointer = { x: e.clientX, y: e.clientY };
      this.#overChrome = this.#insideChrome(e.target);
    });
    document.documentElement.addEventListener("pointerleave", () => {
      this.#pointer = null;
      this.#overChrome = false;
    });
    window.addEventListener("blur", () => this.#visibility.hide());
    window.addEventListener(
      "pointerdown",
      (e) => {
        if (this.#open && !this.#insideChrome(e.target)) this.#setOpen(null);
      },
      { capture: true },
    );
    // Capturing on window runs before the input router's own window
    // listener, so an Escape that closes a panel never reaches the phone.
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || !this.#open) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.#swallowEscapeUp = true;
        this.#setOpen(null);
      },
      { capture: true },
    );
    window.addEventListener(
      "keyup",
      (e) => {
        if (e.key !== "Escape" || !this.#swallowEscapeUp) return;
        e.stopImmediatePropagation();
        this.#swallowEscapeUp = false;
      },
      { capture: true },
    );
    // A clicked button would otherwise keep focus, and Space or Enter meant
    // for the phone would press it again (Close, say).
    this.root.addEventListener("click", (e) => {
      const button = (e.target as Element | null)?.closest?.("button");
      if (button instanceof HTMLButtonElement) button.blur();
    });
  }
}
