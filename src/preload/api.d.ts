import type { DeviceSettings, Settings, SettingsPatch } from "../shared/settings";

export interface HingeApi {
  setWindowSize(w: number, h: number, rotation: 0 | 1 | 2 | 3): void;
  beginDrag(): void;
  endDrag(): void;
  workAreaHeight(): Promise<number>;
  /** Resolves a dropped File to its absolute filesystem path; renderer File objects no longer expose .path directly. */
  getPathForFile(file: File): string;
  settings(): Promise<Settings>;
  settingsPath(): Promise<string>;
  saveSettings(patch: SettingsPatch): Promise<void>;
  saveDeviceSettings(serial: string, patch: DeviceSettings): Promise<void>;
  /** Called with the whole settings object after every save, whoever made it. */
  onSettings(fn: (settings: Settings) => void): void;
  toggleFullscreen(): void;
  onFullscreen(fn: (on: boolean) => void): void;
  quit(): void;
  /** process.platform of the app, e.g. "linux", "win32". */
  readonly platform: string;
}
declare global {
  interface Window {
    hinge: HingeApi;
  }
}
