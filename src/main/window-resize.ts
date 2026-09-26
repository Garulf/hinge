import { clampToWorkArea, type Rect } from "../shared/clamp-bounds";
import { anchoredRect, centredRect, NO_PAD, type Pad } from "../shared/layout";
import type { Rotation } from "../shared/screen-uv";

/** A fold (same rotation) keeps the fixed half's edge in place; a turn, or the first placement, keeps the window centred. */
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

function padded(rect: Rect, pad: Pad): Rect {
  return { x: rect.x - pad.x, y: rect.y - pad.y, width: rect.width + 2 * pad.x, height: rect.height + 2 * pad.y };
}

/**
 * Places the window's content bounds across a sequence of size requests,
 * clamped to the work area. A clamp against the
 * work area gives up the anchor for that one placement only: while the
 * window still sits where it was put, the next size is anchored from where
 * it would have been without the clamp, so growing past a screen edge and
 * shrinking back lands where it started.
 *
 * The size is the work view's window; a pad grows the window around it
 * evenly (for a turned phone), outside the clamp, so the phone inside never
 * moves while the pad comes and goes.
 */
export class WindowPlacer {
  #rotation: Rotation | null = null;
  #applied: Rect | null = null;
  #intended: Rect | null = null;
  #pad: Pad = NO_PAD;

  place(current: Rect, next: { w: number; h: number }, rotation: Rotation, area: Rect, pad: Pad = NO_PAD): Rect {
    const placedHere = this.#applied && this.#intended && near(current, padded(this.#applied, this.#pad));
    const from = placedHere ? this.#intended! : padded(current, { x: -this.#pad.x, y: -this.#pad.y });
    const intended = unclampedBounds(from, next, rotation, this.#rotation);
    const applied = clampToWorkArea(intended, area);
    this.#rotation = rotation;
    this.#intended = intended;
    this.#applied = applied;
    this.#pad = pad;
    return padded(applied, pad);
  }
}
