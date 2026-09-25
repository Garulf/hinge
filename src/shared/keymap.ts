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
