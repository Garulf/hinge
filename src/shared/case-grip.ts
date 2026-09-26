/** A point on the phone's body as it faces the window when straight on, in CSS px from its top-left corner, with the body's size and scale. */
export interface BodyPoint {
  x: number;
  y: number;
  w: number;
  h: number;
  pxPerMm: number;
}

/** What a left press on the case (off the lit screen) does: turn the phone, or move the window. */
export type Grip = "turn" | "move";

const CORNER_MM = 10;
const CORNER_MIN_PX = 16;

/** The size of each corner's square, which stays a real target at small scales without swallowing a short edge. */
export function cornerPx(p: Pick<BodyPoint, "w" | "h" | "pxPerMm">): number {
  return Math.min(Math.max(CORNER_MM * p.pxPerMm, CORNER_MIN_PX), Math.min(p.w, p.h) / 4);
}

/**
 * Corners and the left and right sides turn the phone; the top and bottom
 * move the window. Away from the corners the nearest edge decides, so the
 * side bezels turn and the top and bottom bezels move, and a dark screen
 * splits between them along its diagonals.
 */
export function caseGrip(p: BodyPoint): Grip {
  const fromSide = Math.min(p.x, p.w - p.x);
  const fromEnd = Math.min(p.y, p.h - p.y);
  const corner = cornerPx(p);
  if (fromSide < corner && fromEnd < corner) return "turn";
  return fromEnd < fromSide ? "move" : "turn";
}
