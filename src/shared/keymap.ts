import type { ControlIntent } from "./wire";

export interface KeyEventLike {
  type: "keydown" | "keyup";
  code: string;
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_CODES = new Set(["AltLeft", "AltRight", "MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight"]);

const CODES: Record<string, number> = {
  Enter: 66,
  NumpadEnter: 160,
  Backspace: 67,
  Delete: 112,
  Tab: 61,
  Escape: 111,
  Space: 62,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  Insert: 124,
  ...Object.fromEntries("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c, i) => [`Key${c}`, 29 + i])),
  ...Object.fromEntries("0123456789".split("").map((d, i) => [`Digit${d}`, 7 + i])),
};

function metaStateOf(e: KeyEventLike): number {
  let state = 0;
  if (e.ctrlKey) state |= 4096 | 8192;
  if (e.shiftKey) state |= 1 | 64;
  return state;
}

export function keyIntents(e: KeyEventLike): ControlIntent[] {
  if (MODIFIER_CODES.has(e.code)) return [];
  if (e.altKey || e.metaKey) return [];

  if ([...e.key].length === 1) {
    if (e.type === "keyup") return [];
    if (!e.ctrlKey) return [{ type: "text", text: e.key }];
  }

  const keyCode = CODES[e.code];
  if (keyCode === undefined) return [];
  return [
    {
      type: "key",
      action: e.type === "keydown" ? "down" : "up",
      keyCode,
      repeat: e.repeat ? 1 : 0,
      metaState: metaStateOf(e),
    },
  ];
}

/**
 * Wraps keyIntents with the held-key bookkeeping it cannot do as a pure
 * per-event function: a ctrl+letter combo sends its down as a keyCode (not
 * text), but the matching keyup is for a printable single-character key,
 * which keyIntents always treats as text-only and reports as []. Remember
 * which codes were sent as a keyCode down and always send their up,
 * regardless of what the modifiers look like by the time the key is
 * released (ctrl can already be gone, or the reported key can differ).
 */
export class KeyTracker {
  #held = new Map<string, number>();

  handle(e: KeyEventLike): ControlIntent[] {
    if (e.type === "keyup") {
      const keyCode = this.#held.get(e.code);
      if (keyCode !== undefined) {
        this.#held.delete(e.code);
        return [{ type: "key", action: "up", keyCode, repeat: 0, metaState: metaStateOf(e) }];
      }
    }

    const intents = keyIntents(e);
    if (e.type === "keydown") {
      for (const intent of intents) {
        if (intent.type === "key" && intent.action === "down") this.#held.set(e.code, intent.keyCode);
      }
    }
    return intents;
  }

  /** Sends an up for every key still held, e.g. when the window loses focus. */
  flush(): ControlIntent[] {
    const ups: ControlIntent[] = [...this.#held.values()].map((keyCode) => ({ type: "key", action: "up", keyCode, repeat: 0, metaState: 0 }));
    this.#held.clear();
    return ups;
  }
}
