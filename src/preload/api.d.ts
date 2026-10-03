import type { DeviceSettings, Settings, SettingsPatch } from "../shared/settings";

export interface HingeApi {
  /** `w` by `h` is the work view's window; `pad` grows it evenly on opposite sides, around a turned phone. */
  setWindowSize(w: number, h: number, rotation: 0 | 1 | 2 | 3, pad: { x: number; y: number }): void;
  beginDrag(): void;
  endDrag(): void;
  /** The size of the display work area the window is on, in CSS px. */
  workArea(): Promise<{ width: number; height: number }>;
  /** Called when the work area may have changed: display settings, a move to another display, or a restored window position. */
  onWorkAreaChanged(fn: () => void): void;
  /** Resolves a dropped File to its absolute filesystem path; renderer File objects no longer expose .path directly. */
  getPathForFile(file: File): string;
  settings(): Promise<Settings>;
  settingsPath(): Promise<string>;
  saveSettings(patch: SettingsPatch): Promise<void>;
  /** id is the phone identity from the streaming status. */
  saveDeviceSettings(id: string, patch: DeviceSettings): Promise<void>;
  /** Called with the whole settings object after every save, whoever made it. */
  onSettings(fn: (settings: Settings) => void): void;
  toggleFullscreen(): void;
  onFullscreen(fn: (on: boolean) => void): void;
  quit(): void;
  /** The menu's close button: to the tray when closeToTray is on and there is one, otherwise the same as quit. */
  close(): void;
  /** process.platform of the app, e.g. "linux", "win32". */
  readonly platform: string;
}
declare global {
  interface Window {
    hinge: HingeApi;
  }
}
