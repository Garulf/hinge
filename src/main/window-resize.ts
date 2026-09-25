import { clampToWorkArea, type Rect } from "../shared/clamp-bounds";
import { anchoredRect } from "../shared/layout";

/** Anchors the window's content bounds to the fixed half's edge for the new size, then clamps to the work area. */
export function anchoredWindowBounds(current: Rect, next: { w: number; h: number }, rotation: 0 | 1 | 2 | 3, area: Rect): Rect {
  const anchored = anchoredRect({ x: current.x, y: current.y, w: current.width, h: current.height }, next, rotation);
  const rounded: Rect = { x: Math.round(anchored.x), y: Math.round(anchored.y), width: Math.round(anchored.w), height: Math.round(anchored.h) };
  return clampToWorkArea(rounded, area);
}
