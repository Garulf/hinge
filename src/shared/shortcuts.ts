import type { KeyEventLike } from "./keymap";
import type { ModifierKey, ModifierTracker } from "./modifiers";
import type { ControlIntent } from "./wire";

export type HingeAction =
  | "center"
  | "fullscreen"
  | "pixel-perfect"
  | "fit"
  | "quit"
  | "close"
  | "toggle-fps"
  | "pause"
  | "unpause"
  | "scale-up"
  | "scale-down"
  | "popout-current";

export const SHORTCUT_MODIFIERS: readonly ModifierKey[] = ["lalt", "ralt", "lsuper", "rsuper", "lctrl", "rctrl"];
export const DEFAULT_MODIFIERS: readonly ModifierKey[] = ["lalt", "lsuper"];
const WINDOWS_DEFAULT_MODIFIERS: readonly ModifierKey[] = ["lalt"];

/** Windows reserves most Win+letter combinations for itself, so MOD there is left Alt alone. */
export function defaultModifiers(platform: string): ModifierKey[] {
  return [...(platform === "win32" ? WINDOWS_DEFAULT_MODIFIERS : DEFAULT_MODIFIERS)];
}

/** Settings come from a file on disk, so anything unknown is dropped; an empty result falls back to the default. */
export function normaliseModifiers(value: unknown, fallback: readonly ModifierKey[] = DEFAULT_MODIFIERS): ModifierKey[] {
  const raw = Array.isArray(value) ? value : [value];
  const picked = [...new Set(raw.filter((v): v is ModifierKey => SHORTCUT_MODIFIERS.includes(v as ModifierKey)))];
  return picked.length > 0 ? picked : [...fallback];
}

const KEYCODE = {
  HOME: 3,
  BACK: 4,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  MENU: 82,
  APP_SWITCH: 187,
  CUT: 277,
  COPY: 278,
} as const;

type Binding =
  | { kind: "key"; keyCode: number; repeats?: true }
  | { kind: "intent"; intent: ControlIntent }
  | { kind: "notifications" }
  | { kind: "action"; action: HingeAction };

const keyBinding = (keyCode: number, repeats?: true): Binding => ({ kind: "key", keyCode, repeats });
const intent = (i: ControlIntent): Binding => ({ kind: "intent", intent: i });
const action = (a: HingeAction): Binding => ({ kind: "action", action: a });

/** scrcpy's shortcut table (doc/shortcuts.md) keyed by KeyboardEvent.code, without and with Shift; plus hinge's own d and t. */
export const SHORTCUT_TABLE: Record<string, { plain?: Binding; shift?: Binding }> = {
  KeyF: { plain: action("fullscreen") },
  KeyG: { plain: action("pixel-perfect") },
  KeyW: { plain: action("fit") },
  KeyH: { plain: keyBinding(KEYCODE.HOME) },
  KeyB: { plain: keyBinding(KEYCODE.BACK) },
  Backspace: { plain: keyBinding(KEYCODE.BACK) },
  KeyS: { plain: keyBinding(KEYCODE.APP_SWITCH) },
  KeyM: { plain: keyBinding(KEYCODE.MENU) },
  ArrowUp: { plain: keyBinding(KEYCODE.VOLUME_UP, true) },
  ArrowDown: { plain: keyBinding(KEYCODE.VOLUME_DOWN, true) },
  KeyP: { plain: keyBinding(KEYCODE.POWER) },
  KeyO: { plain: intent({ type: "display-power", on: false }), shift: intent({ type: "display-power", on: true }) },
  KeyR: { plain: intent({ type: "rotate-device" }), shift: intent({ type: "reset-video" }) },
  KeyN: { plain: { kind: "notifications" }, shift: intent({ type: "collapse-panels" }) },
  KeyC: { plain: keyBinding(KEYCODE.COPY) },
  KeyX: { plain: keyBinding(KEYCODE.CUT) },
  KeyV: { plain: intent({ type: "clipboard-paste", asText: false }), shift: intent({ type: "clipboard-paste", asText: true }) },
  KeyI: { plain: action("toggle-fps") },
  KeyQ: { plain: action("quit") },
  KeyZ: { plain: action("pause"), shift: action("unpause") },
  KeyD: { plain: action("center") },
  KeyT: { plain: action("popout-current") },
};

function bindingFor(code: string, shift: boolean): Binding | undefined {
  const entry = SHORTCUT_TABLE[code];
  return shift ? entry?.shift : entry?.plain;
}

/**
 * What a key event did as a shortcut. `claimed` says whether the browser
 * default should be prevented; an unmapped MOD combo is swallowed (nothing
 * goes to the phone) but left unclaimed so Alt+F4 and friends reach the OS.
 */
export interface ShortcutOutcome {
  intents: ControlIntent[];
  action: HingeAction | null;
  claimed: boolean;
}

const NOTHING: ShortcutOutcome = { intents: [], action: null, claimed: true };

function isAltGrText(e: KeyEventLike): boolean {
  return e.ctrlKey && e.altKey && !e.metaKey && [...e.key].length === 1;
}

export class ShortcutHandler {
  readonly #modifiers: Pick<ModifierTracker, "held">;
  readonly #accepted: () => readonly ModifierKey[];
  readonly #allows: (code: string, shift: boolean) => boolean;
  readonly #heldKeys = new Map<string, number>();
  #lastPress: { code: string; shift: boolean } | null = null;
  #pressCount = 0;

  /** A MOD combo that `allows` refuses is treated as unmapped. */
  constructor(
    modifiers: Pick<ModifierTracker, "held">,
    accepted: () => readonly ModifierKey[] = () => DEFAULT_MODIFIERS,
    allows: (code: string, shift: boolean) => boolean = () => true,
  ) {
    this.#modifiers = modifiers;
    this.#accepted = accepted;
    this.#allows = allows;
  }

  modHeld(): boolean {
    return this.#accepted().some((modifier) => this.#modifiers.held(modifier));
  }

  /** null when the event is not a shortcut and should be handled as ordinary typing. */
  handle(e: KeyEventLike, paused: boolean): ShortcutOutcome | null {
    const down = e.type === "keydown";
    if (down && !e.repeat) this.#countPress(e);

    if (e.code === "F11") {
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return null;
      return down && !e.repeat ? { ...NOTHING, action: "fullscreen" } : NOTHING;
    }

    if (!down) {
      const keyCode = this.#heldKeys.get(e.code);
      if (keyCode !== undefined) {
        this.#heldKeys.delete(e.code);
        return { ...NOTHING, intents: [keyIntent("up", keyCode, 0)] };
      }
    }

    if (!this.modHeld() || isAltGrText(e)) return null;
    const binding = this.#allows(e.code, e.shiftKey) ? bindingFor(e.code, e.shiftKey) : undefined;
    if (!binding) return { intents: [], action: null, claimed: false };
    if (!down) return NOTHING;

    switch (binding.kind) {
      case "action":
        return e.repeat ? NOTHING : { ...NOTHING, action: binding.action };
      case "key":
        if (paused || (e.repeat && !binding.repeats)) return NOTHING;
        this.#heldKeys.set(e.code, binding.keyCode);
        return { ...NOTHING, intents: [keyIntent("down", binding.keyCode, e.repeat ? 1 : 0)] };
      case "intent":
        return paused || e.repeat ? NOTHING : { ...NOTHING, intents: [binding.intent] };
      case "notifications":
        if (paused || e.repeat) return NOTHING;
        return { ...NOTHING, intents: [{ type: this.#pressCount === 0 ? "expand-notifications" : "expand-settings" }] };
    }
  }

  /** Sends an up for every device key a shortcut still holds down, e.g. when the window loses focus. */
  flush(): ControlIntent[] {
    const ups = [...this.#heldKeys.values()].map((keyCode) => keyIntent("up", keyCode, 0));
    this.#heldKeys.clear();
    return ups;
  }

  /** scrcpy counts presses of the same key with the same modifiers; any other key in between, MOD included, starts over. */
  #countPress(e: KeyEventLike): void {
    const last = this.#lastPress;
    if (last && last.code === e.code && last.shift === e.shiftKey) this.#pressCount++;
    else this.#pressCount = 0;
    this.#lastPress = { code: e.code, shift: e.shiftKey };
  }
}

function keyIntent(action: "down" | "up", keyCode: number, repeat: number): ControlIntent {
  return { type: "key", action, keyCode, repeat, metaState: 0 };
}
