import { clampToWorkArea, type Rect } from "../shared/clamp-bounds";
import { anchoredRect, centredRect } from "../shared/layout";
import type { Rotation } from "../shared/screen-uv";

/**
 * Places the window's content bounds for a new size, then clamps them to the
 * work area: a fold (same rotation) keeps the fixed half's edge in place, a
 * turn (or the first placement) keeps the window centred.
 */
export function anchoredWindowBounds(current: Rect, next: { w: number; h: number }, rotation: Rotation, previousRotation: Rotation | null, area: Rect): Rect {
  const from = { x: current.x, y: current.y, w: current.width, h: current.height };
  const placed = rotation === previousRotation ? anchoredRect(from, next, rotation) : centredRect(from, next);
  const rounded: Rect = { x: Math.round(placed.x), y: Math.round(placed.y), width: Math.round(placed.w), height: Math.round(placed.h) };
  return clampToWorkArea(rounded, area);
}
