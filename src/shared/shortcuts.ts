export type HingeAction = "toggle-view";

interface ShortcutEventLike {
  code: string;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  type: "keydown" | "keyup";
  repeat: boolean;
}

/** MOD is left Alt or left Super; M5 makes it configurable from this seed. */
export function hingeShortcut(e: ShortcutEventLike): HingeAction | null {
  if (e.type !== "keydown" || e.repeat || e.ctrlKey || e.code !== "KeyD") return null;
  return e.altKey || e.metaKey ? "toggle-view" : null;
}
