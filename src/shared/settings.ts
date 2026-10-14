import type { Rect } from "./clamp-bounds";
import type { ModelAngles } from "./model-rotation";
import type { ModifierKey } from "./modifiers";

export type ShortcutModifier = ModifierKey;

export interface DeviceSettings {
  /** The window's top-right corner: the fixed half's edge, which folding keeps in place. */
  windowPosition?: { x: number; y: number };
  pxPerMm?: number;
  /** The model's turn, left where the user left it until Center. */
  rotation?: ModelAngles;
  /** Each pop-out app's window bounds, frame included, keyed by package. */
  popouts?: Record<string, Rect>;
}

export interface Settings {
  version: 6;
  colourway: string;
  videoCodec: "h264" | "h265";
  videoBitRate: number;
  maxSize: number;
  maxFps: number;
  audio: boolean;
  shortcutModifiers: ShortcutModifier[];
  alwaysOnTop: boolean;
  /** "swipe" scrolls the phone with a finger swipe per burst of wheel notches, which the phone finishes with its own fling; "events" sends scroll events. */
  wheelStyle: "swipe" | "events";
  /** How long a mouse wheel notch sent as scroll events eases out over on the phone, in ms; 0 scrolls it in one jump. */
  scrollSmoothing: number;
  /** How far a wheel notch scrolls, as a multiple of Android's own mouse scroll step. */
  scrollSpeed: number;
  /** A phone's identity (see deviceIdentity), or an adb serial left over from a version 1 file until that phone is seen again. */
  lastDevice: string | null;
  /** Mirrors the phone's notifications to the PC as they arrive; on by default. */
  mirrorNotifications: boolean;
  /** The main window's close button hides it to the system tray, leaving hinge running, instead of quitting; off by default. */
  closeToTray: boolean;
  /** Draws hinge's own PIN or password pad over a lock screen the mirror shows as black; on by default. */
  showUnlockScreen: boolean;
  /** Keyed by the phone's identity, which stays the same across USB, Wi-Fi and a changing wireless port. */
  devices: Record<string, DeviceSettings>;
  /** Version 1 entries, keyed by an adb transport serial; each moves into devices when that serial's identity is first seen. */
  legacyDevices?: Record<string, DeviceSettings>;
}

export type SettingsPatch = Partial<Omit<Settings, "version" | "devices" | "legacyDevices">>;

/** The phone last connected and what was saved for it, so its scale, turn and window corner can be in place before it streams. */
export function startupDevice(settings: Settings): { id: string; saved: DeviceSettings } | null {
  const id = settings.lastDevice;
  if (!id) return null;
  return { id, saved: settings.devices[id] ?? settings.legacyDevices?.[id] ?? {} };
}
