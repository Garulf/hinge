import { normaliseModifiers } from "../shared/shortcuts";
import type { DeviceSettings, SettingsPatch } from "../shared/settings";
import { DEFAULT_SETTINGS, type Settings, type SettingsStore } from "./settings";

type PatchKey = keyof SettingsPatch;

const CHOICES: Partial<Record<PatchKey, readonly unknown[]>> = {
  videoCodec: ["h264", "h265"],
  view: ["work", "showcase"],
};

function validValue(key: PatchKey, value: unknown): boolean {
  const choices = CHOICES[key];
  if (choices) return choices.includes(value);
  if (key === "lastDevice") return value === null || typeof value === "string";
  if (key === "shortcutModifiers") return Array.isArray(value);
  const expected = typeof DEFAULT_SETTINGS[key];
  if (expected === "number") return typeof value === "number" && Number.isFinite(value) && value >= 0;
  return typeof value === expected;
}

/** A patch arrives from the renderer over IPC, so only known keys with values of the right type get through. */
export function sanitisePatch(patch: unknown): SettingsPatch {
  if (typeof patch !== "object" || patch === null) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "version" || key === "devices" || !(key in DEFAULT_SETTINGS)) continue;
    if (!validValue(key as PatchKey, value)) continue;
    result[key] = key === "shortcutModifiers" ? normaliseModifiers(value) : value;
  }
  return result as SettingsPatch;
}

export function sanitiseDevicePatch(patch: unknown): DeviceSettings {
  if (typeof patch !== "object" || patch === null) return {};
  const { pxPerMm, windowPosition } = patch as Record<string, unknown>;
  const result: DeviceSettings = {};
  if (typeof pxPerMm === "number" && Number.isFinite(pxPerMm) && pxPerMm > 0) result.pxPerMm = pxPerMm;
  if (typeof windowPosition === "object" && windowPosition !== null) {
    const { x, y } = windowPosition as Record<string, unknown>;
    if (Number.isFinite(x) && Number.isFinite(y)) result.windowPosition = { x: x as number, y: y as number };
  }
  return result;
}

export interface SettingsIpc {
  handle(channel: string, fn: (event: { sender: unknown }, ...args: unknown[]) => unknown): void;
}

export interface SettingsWindow {
  webContents: { send(channel: string, value: unknown): void };
  setAlwaysOnTop(flag: boolean): void;
}

/** Serves the store to one window's renderer, pushes every change back to it, and applies the window-level settings. */
export function bridgeSettings(win: SettingsWindow, store: SettingsStore, ipc: SettingsIpc, path: string): void {
  const fromWindow = (event: { sender: unknown }) => event.sender === win.webContents;
  ipc.handle("hinge:settings-path", (event) => (fromWindow(event) ? path : null));
  ipc.handle("hinge:settings-get", (event) => (fromWindow(event) ? store.current : null));
  ipc.handle("hinge:settings-save", (event, patch) => (fromWindow(event) ? store.save(sanitisePatch(patch)) : undefined));
  ipc.handle("hinge:settings-save-device", (event, serial, patch) => {
    if (!fromWindow(event) || typeof serial !== "string" || serial === "") return undefined;
    return store.saveDevice(serial, sanitiseDevicePatch(patch));
  });
  let alwaysOnTop = store.current.alwaysOnTop;
  win.setAlwaysOnTop(alwaysOnTop);
  store.onChange((settings: Settings) => {
    if (settings.alwaysOnTop !== alwaysOnTop) {
      alwaysOnTop = settings.alwaysOnTop;
      win.setAlwaysOnTop(alwaysOnTop);
    }
    win.webContents.send("hinge:settings", settings);
  });
}
