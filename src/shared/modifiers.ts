export type ModifierKey = "lalt" | "ralt" | "lsuper" | "rsuper" | "lctrl" | "rctrl";

interface ModifierEventLike {
  type: "keydown" | "keyup";
  code: string;
}

const CODE_TO_MODIFIER: Record<string, ModifierKey> = {
  AltLeft: "lalt",
  AltRight: "ralt",
  MetaLeft: "lsuper",
  MetaRight: "rsuper",
  ControlLeft: "lctrl",
  ControlRight: "rctrl",
};

/**
 * Tracks which side of Alt, Super and Ctrl is physically held, from
 * KeyboardEvent.code on keydown/keyup: altKey/metaKey/ctrlKey on a
 * KeyboardEvent for an unrelated key can't tell left from right (and altKey
 * is also true for AltGr on many layouts), so a shortcut that must fire for
 * one side only needs this instead.
 */
export class ModifierTracker {
  #held = new Set<ModifierKey>();

  handle(e: ModifierEventLike): void {
    const modifier = CODE_TO_MODIFIER[e.code];
    if (!modifier) return;
    if (e.type === "keydown") this.#held.add(modifier);
    else this.#held.delete(modifier);
  }

  held(modifier: ModifierKey): boolean {
    return this.#held.has(modifier);
  }

  /** Forgets every held modifier, e.g. when the window loses focus. */
  clear(): void {
    this.#held.clear();
  }
}
