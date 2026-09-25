export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Keeps a window rect within a display's work area, e.g. after a fold changes its size and it gets recentered. */
export function clampToWorkArea(bounds: Rect, area: Rect): Rect {
  const maxX = area.x + Math.max(0, area.width - bounds.width);
  const maxY = area.y + Math.max(0, area.height - bounds.height);
  return {
    x: Math.min(Math.max(bounds.x, area.x), maxX),
    y: Math.min(Math.max(bounds.y, area.y), maxY),
    width: bounds.width,
    height: bounds.height,
  };
}
