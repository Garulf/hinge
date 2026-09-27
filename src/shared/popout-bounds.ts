import { clampToWorkArea, type Rect } from "./clamp-bounds";

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/** A saved pop-out window fitted into the work area it overlaps most; null when nothing is saved or its monitor is gone. */
export function restoreBounds(saved: Rect | undefined, workAreas: Rect[]): Rect | null {
  if (!saved) return null;
  let best: Rect | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const overlap = overlapArea(saved, area);
    if (overlap > bestArea) {
      best = area;
      bestArea = overlap;
    }
  }
  if (!best) return null;
  const fitted = { ...saved, width: Math.min(saved.width, best.width), height: Math.min(saved.height, best.height) };
  return clampToWorkArea(fitted, best);
}
