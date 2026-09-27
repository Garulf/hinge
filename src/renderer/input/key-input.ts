import { KeyTracker, type KeyEventLike } from "../../shared/keymap";
import { ModifierTracker, type ModifierKey } from "../../shared/modifiers";
import { DEFAULT_MODIFIERS, ShortcutHandler, type ShortcutOutcome } from "../../shared/shortcuts";
import type { ControlIntent } from "../../shared/wire";

export function keyEventLike(e: KeyboardEvent): KeyEventLike {
  return {
    type: e.type as "keydown" | "keyup",
    code: e.code,
    key: e.key,
    repeat: e.repeat,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
  };
}

/** What a key event does: `claimed` says whether the browser default should be prevented. */
export type KeyOutcome = ShortcutOutcome;

/** A window's keyboard: MOD shortcuts first, typing for the phone otherwise. */
export class KeyInput {
  readonly #modifiers = new ModifierTracker();
  readonly #keys = new KeyTracker();
  readonly #shortcuts: ShortcutHandler;

  constructor(accepted: () => readonly ModifierKey[] = () => DEFAULT_MODIFIERS, allows?: (code: string, shift: boolean) => boolean) {
    this.#shortcuts = new ShortcutHandler(this.#modifiers, accepted, allows);
  }

  /** Every key event goes through here, even one typed into the window's own fields, so held modifiers stay known. */
  track(e: KeyEventLike): void {
    this.#modifiers.handle(e);
  }

  route(e: KeyEventLike, paused: boolean): KeyOutcome {
    // A key already held down on the phone stays the phone's until released,
    // even if MOD is pressed meanwhile: its repeats and its up go to it.
    const heldOnPhone = this.#keys.holds(e.code) && (e.type === "keyup" || e.repeat);
    const shortcut = heldOnPhone ? null : this.#shortcuts.handle(e, paused);
    if (shortcut) return shortcut;
    if (paused) return { intents: [], action: null, claimed: false };
    const intents = this.#keys.handle(e);
    // Only claim the key when it actually produced something to send to the
    // phone; an unclaimed key (Alt+F4, Alt+Space, ...) must still reach the OS.
    return { intents, action: null, claimed: intents.length > 0 };
  }

  held(modifier: ModifierKey): boolean {
    return this.#modifiers.held(modifier);
  }

  modHeld(): boolean {
    return this.#shortcuts.modHeld();
  }

  forgetModifiers(): void {
    this.#modifiers.clear();
  }

  /** An up for every key the phone still has held down. */
  release(): ControlIntent[] {
    return [...this.#shortcuts.flush(), ...this.#keys.flush()];
  }
}
