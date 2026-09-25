import { clampToWorkArea, type Rect } from "../shared/clamp-bounds";
import { anchoredRect, centredRect } from "../shared/layout";
import type { Rotation } from "../shared/screen-uv";

/**
 * Places the window's content bounds for a new size, then clamps them to the
 * work area: a fold (same rotation) keeps the fixed half's edge in place, a
 * turn (or the first placement) keeps the window centred.
 */
export function anchoredWindowBounds(current: Rect, next: { w: number; h: number }, rotation: Rotation, previousRotation: Rotation | null, area: Rect): Rect {
  return clampToWorkArea(unclampedBounds(current, next, rotation, previousRotation), area);
}

function unclampedBounds(current: Rect, next: { w: number; h: number }, rotation: Rotation, previousRotation: Rotation | null): Rect {
  const from = { x: current.x, y: current.y, w: current.width, h: current.height };
  const placed = rotation === previousRotation ? anchoredRect(from, next, rotation) : centredRect(from, next);
  return { x: Math.round(placed.x), y: Math.round(placed.y), width: Math.round(placed.w), height: Math.round(placed.h) };
}

const PLACED_TOLERANCE_PX = 1;

function near(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) <= PLACED_TOLERANCE_PX &&
    Math.abs(a.y - b.y) <= PLACED_TOLERANCE_PX &&
    Math.abs(a.width - b.width) <= PLACED_TOLERANCE_PX &&
    Math.abs(a.height - b.height) <= PLACED_TOLERANCE_PX
  );
}

/**
 * Places the window across a sequence of size requests. A clamp against the
 * work area gives up the anchor for that one placement only: while the
 * window still sits where it was put, the next size is anchored from where
 * it would have been without the clamp, so growing past a screen edge and
 * shrinking back lands where it started.
 */
export class WindowPlacer {
  #rotation: Rotation | null = null;
  #applied: Rect | null = null;
  #intended: Rect | null = null;

  place(current: Rect, next: { w: number; h: number }, rotation: Rotation, area: Rect): Rect {
    const from = this.#applied && this.#intended && near(current, this.#applied) ? this.#intended : current;
    const intended = unclampedBounds(from, next, rotation, this.#rotation);
    const applied = clampToWorkArea(intended, area);
    this.#rotation = rotation;
    this.#intended = intended;
    this.#applied = applied;
    return applied;
  }
}
