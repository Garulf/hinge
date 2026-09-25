import type { ModifierKey, ModifierTracker } from "./modifiers";

export type HingeAction = "toggle-view";

interface ShortcutEventLike {
  code: string;
  type: "keydown" | "keyup";
  repeat: boolean;
}

const DEFAULT_MODIFIERS: readonly ModifierKey[] = ["lalt", "lsuper"];

/**
 * MOD is left Alt or left Super by default; `accepted` is what M5 makes
 * configurable. altKey/metaKey on a KeyboardEvent for an unrelated key can't
 * tell left from right, and altKey is also true for AltGr on many layouts,
 * so which side was actually held comes from a ModifierTracker instead.
 */
export function hingeShortcut(
  e: ShortcutEventLike,
  modifiers: Pick<ModifierTracker, "held">,
  accepted: readonly ModifierKey[] = DEFAULT_MODIFIERS,
): HingeAction | null {
  if (e.type !== "keydown" || e.repeat || e.code !== "KeyD") return null;
  if (modifiers.held("lctrl") || modifiers.held("rctrl")) return null;
  return accepted.some((modifier) => modifiers.held(modifier)) ? "toggle-view" : null;
}
