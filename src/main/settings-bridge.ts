import { defaultModifiers, normaliseModifiers } from "../shared/shortcuts";
import type { DeviceSettings, SettingsPatch } from "../shared/settings";
import { isSettingKey, sanitiseDeviceSettings, validSettingValue, type Settings, type SettingsStore } from "./settings";

/** A patch arrives from the renderer over IPC, so only known keys with values of the right type get through. */
export function sanitisePatch(patch: unknown, platform: string = process.platform): SettingsPatch {
  if (typeof patch !== "object" || patch === null) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!isSettingKey(key) || !validSettingValue(key, value)) continue;
    result[key] = key === "shortcutModifiers" ? normaliseModifiers(value, defaultModifiers(platform)) : value;
  }
  return result as SettingsPatch;
}

export function sanitiseDevicePatch(patch: unknown): DeviceSettings {
  return sanitiseDeviceSettings(patch);
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
  ipc.handle("hinge:settings-save-device", (event, id, patch) => {
    if (!fromWindow(event) || typeof id !== "string" || id === "") return undefined;
    return store.saveDevice(id, sanitiseDevicePatch(patch));
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
