import type { Settings, SettingsPatch } from "../../shared/settings";
import type { HingeAction } from "../../shared/shortcuts";
import type { DeviceCommands } from "./device-commands";
import { el, place, svgIcon } from "./dom";
import { MenuVisibility, panelBox, sizeForPanel, type Box, type Size } from "./hit-zone";
import { ICONS, type IconName } from "./icons";
import { ColourPanel, DevicePanel, SettingsPanel, type Panel, type PanelName } from "./panels";
import { CHROME_CSS } from "./styles";
import { ToastQueue, type Toast, type ToastInput } from "./toast-queue";

export interface ChromeLayout {
  window: Size;
  /** Where the phone body is in the window right now. */
  body: Box;
  pxPerMm: number;
}

export interface ChromeDeps {
  commands: DeviceCommands;
  swatches: { id: string; label: string; swatch: string }[];
  save(patch: SettingsPatch): void;
  settingsPath(): Promise<string>;
  onAction(action: HingeAction): void;
  currentSerial(): string | null;
}

const MENU_SIZE = { w: 186, h: 36 };
const MENU_INSET_PX = 4;
const PANEL_GAP_PX = 6;
const TOAST_BEZEL_MM = 6;
const TOAST_MIN_TOP_PX = 44;

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
  #open: PanelName | null = null;
  #layout: ChromeLayout | null = null;
  #pointer: { x: number; y: number } | null = null;
  #overChrome = false;
  #settings: Settings | null = null;

  constructor(parent: HTMLElement, deps: ChromeDeps) {
    this.#deps = deps;
    parent.append(el("style", { text: CHROME_CSS }));
    const menuButtons: MenuButton[] = [
      { name: "device", title: "Devices", press: () => this.#toggle("device") },
      { name: "view", title: "Switch view (MOD+d)", press: () => deps.onAction("toggle-view") },
      { name: "colour", title: "Colour", press: () => this.#toggle("colour") },
      { name: "pin", title: "Always on top", press: () => deps.save({ alwaysOnTop: !this.#settings?.alwaysOnTop }) },
      { name: "settings", title: "Settings", press: () => this.#toggle("settings") },
      { name: "close", title: "Quit (MOD+q)", press: () => deps.onAction("quit") },
    ];
    this.#menu = el("div", { className: "hinge-menu hinge-glass", attrs: { role: "toolbar", "data-menu": "" } });
    for (const button of menuButtons) {
      const node = el("button", { className: button.name, title: button.title, attrs: { "data-button": button.name }, on: { click: button.press } }, [svgIcon(ICONS[button.name])]);
      this.#buttons.set(button.name, node);
      this.#menu.append(node);
    }
    this.#toastsNode = el("div", { className: "hinge-toasts", attrs: { "aria-live": "polite" } });
    this.#panels = {
      device: new DevicePanel({ commands: deps.commands, toast: (t) => this.toast(t), currentSerial: deps.currentSerial }),
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

  settingsChanged(settings: Settings): void {
    this.#settings = settings;
    this.#buttons.get("pin")?.setAttribute("aria-pressed", String(settings.alwaysOnTop));
    for (const panel of Object.values(this.#panels)) panel.settingsChanged(settings);
  }

  setFps(text: string | null): void {
    this.#fps.hidden = text === null;
    this.#fps.textContent = text ?? "";
  }

  /** The window size an open panel needs, for the window to grow to while it is open. */
  neededWindow(): Size | null {
    return this.#open ? sizeForPanel(this.#panels[this.#open].size, MENU_INSET_PX + MENU_SIZE.h + PANEL_GAP_PX) : null;
  }

  closePanel(): void {
    this.#setOpen(null);
  }

  update(layout: ChromeLayout, nowMs: number): void {
    this.#layout = layout;
    const { body } = layout;
    this.#visibility.pointer(this.#pointer, body, this.#overChrome, nowMs);
    const menuTop = body.y + MENU_INSET_PX;
    this.#menu.classList.toggle("shown", this.#visibility.visible(nowMs, this.#open !== null));
    place(this.#menu, { x: body.x + (body.w - MENU_SIZE.w) / 2, y: menuTop });

    if (this.#open) {
      const panel = this.#panels[this.#open];
      const box = panelBox(body, layout.window, panel.size, menuTop + MENU_SIZE.h + PANEL_GAP_PX);
      place(panel.node, box);
      panel.node.style.maxHeight = `${Math.max(120, layout.window.h - box.y - 8)}px`;
    }

    const toastTop = body.y + Math.max(TOAST_BEZEL_MM * layout.pxPerMm, TOAST_MIN_TOP_PX);
    place(this.#toastsNode, { x: body.x + 12, y: toastTop, w: Math.max(80, body.w - 24) });
    this.#renderToasts(this.#queue.visible(nowMs));

    place(this.#fps, { x: body.x + body.w / 2, y: body.y + body.h - 3 });
  }

  #renderToasts(toasts: Toast[]): void {
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

  #toggle(name: PanelName): void {
    this.#setOpen(this.#open === name ? null : name);
  }

  #setOpen(name: PanelName | null): void {
    if (this.#open === name) return;
    if (this.#open) this.#panels[this.#open].node.remove();
    this.#open = name;
    for (const panelName of ["device", "colour", "settings"] as const) this.#buttons.get(panelName)?.setAttribute("aria-pressed", String(panelName === name));
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
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.#setOpen(null);
    });
  }
}
