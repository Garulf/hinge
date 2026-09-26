import type { ModelAngles } from "./model-rotation";
import type { ModifierKey } from "./modifiers";

export type ShortcutModifier = ModifierKey;

export interface DeviceSettings {
  /** The window's top-right corner: the fixed half's edge, which folding keeps in place. */
  windowPosition?: { x: number; y: number };
  pxPerMm?: number;
  view?: "work" | "showcase";
  /** The model's turn (Alt+drag), left where the user left it. */
  rotation?: ModelAngles;
}

export interface Settings {
  version: 3;
  colourway: string;
  videoCodec: "h264" | "h265";
  videoBitRate: number;
  maxSize: number;
  maxFps: number;
  audio: boolean;
  shortcutModifiers: ShortcutModifier[];
  alwaysOnTop: boolean;
  /** A phone's identity (see deviceIdentity), or an adb serial left over from a version 1 file until that phone is seen again. */
  lastDevice: string | null;
  view: "work" | "showcase";
  /** Keyed by the phone's identity, which stays the same across USB, Wi-Fi and a changing wireless port. */
  devices: Record<string, DeviceSettings>;
  /** Version 1 entries, keyed by an adb transport serial; each moves into devices when that serial's identity is first seen. */
  legacyDevices?: Record<string, DeviceSettings>;
}

export type SettingsPatch = Partial<Omit<Settings, "version" | "devices" | "legacyDevices">>;

/** The phone last connected and what was saved for it, so its scale, view, turn and window corner can be in place before it streams. */
export function startupDevice(settings: Settings): { id: string; saved: DeviceSettings } | null {
  const id = settings.lastDevice;
  if (!id) return null;
  return { id, saved: settings.devices[id] ?? settings.legacyDevices?.[id] ?? {} };
}
