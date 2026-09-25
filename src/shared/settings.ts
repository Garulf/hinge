import type { ModifierKey } from "./modifiers";

export type ShortcutModifier = ModifierKey;

export interface DeviceSettings {
  /** The window's top-right corner: the fixed half's edge, which folding keeps in place. */
  windowPosition?: { x: number; y: number };
  pxPerMm?: number;
  view?: "work" | "showcase";
}

export interface Settings {
  version: 1;
  colourway: string;
  videoCodec: "h264" | "h265";
  videoBitRate: number;
  maxSize: number;
  maxFps: number;
  audio: boolean;
  shortcutModifiers: ShortcutModifier[];
  alwaysOnTop: boolean;
  lastDevice: string | null;
  view: "work" | "showcase";
  devices: Record<string, DeviceSettings>;
}

export type SettingsPatch = Partial<Omit<Settings, "version" | "devices">>;
