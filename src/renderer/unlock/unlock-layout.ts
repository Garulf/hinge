export type UnlockMode = "pin" | "password" | "pattern";
export type KeyId = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "back" | "ok";
export type HitId = KeyId | "switch" | "cancel";

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UnlockLayout {
  scale: number;
  icon: Circle;
  promptY: number;
  promptSize: number;
  hint: { y: number; size: number };
  entry: Box;
  keys: { id: KeyId; circle: Circle }[];
  switchLink: Box | null;
  cancel: Box;
}

/** The pad is laid out on a 360 x 640 reference screen, scaled to fit and centred. */
const REF = { w: 360, h: 640 };
const PIN_ROWS: KeyId[][] = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["back", "0", "ok"],
];

export function unlockLayout(w: number, h: number, mode: UnlockMode, canSwitch: boolean): UnlockLayout {
  const s = Math.min(w / REF.w, h / REF.h);
  const ox = (w - REF.w * s) / 2;
  const oy = (h - REF.h * s) / 2;
  const box = (x: number, y: number, bw: number, bh: number): Box => ({ x: ox + x * s, y: oy + y * s, w: bw * s, h: bh * s });
  const circle = (x: number, y: number, r: number): Circle => ({ cx: ox + x * s, cy: oy + y * s, r: r * s });
  const keys = mode === "pin" ? PIN_ROWS.flatMap((row, r) => row.map((id, c) => ({ id, circle: circle(90 + c * 90, 260 + r * 80, 34) }))) : [];
  const hintY = mode === "pattern" ? 175 : 230;
  return {
    scale: s,
    icon: circle(180, 90, 14),
    promptY: oy + 135 * s,
    promptSize: 20 * s,
    hint: { y: oy + hintY * s, size: 14 * s },
    entry: box(60, 165, 240, 36),
    keys,
    switchLink: canSwitch && mode !== "pattern" ? box(110, mode === "pin" ? 548 : 270, 140, 28) : null,
    cancel: box(130, 590, 100, 32),
  };
}

function inBox(b: Box, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

export function hitAt(layout: UnlockLayout, x: number, y: number): HitId | null {
  for (const { id, circle } of layout.keys) if (Math.hypot(x - circle.cx, y - circle.cy) <= circle.r) return id;
  if (layout.switchLink && inBox(layout.switchLink, x, y)) return "switch";
  if (inBox(layout.cancel, x, y)) return "cancel";
  return null;
}

export function hitCentre(layout: UnlockLayout, id: HitId): { x: number; y: number } | null {
  const key = layout.keys.find((k) => k.id === id);
  if (key) return { x: key.circle.cx, y: key.circle.cy };
  const box = id === "cancel" ? layout.cancel : id === "switch" ? layout.switchLink : null;
  return box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : null;
}
