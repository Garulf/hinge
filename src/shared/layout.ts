export interface BodyDims {
  openWidthMm: number;
  closedWidthMm: number;
  heightMm: number;
}

/** Open 143.7 mm and closed 72.1 mm (both incl. the volume rocker), height 158.4 mm; measured from fold7.glb. */
export const FOLD7_BODY: BodyDims = { openWidthMm: 143.7, closedWidthMm: 72.1, heightMm: 158.4 };

/** CSS px per mm that fills 85 percent of the display work area height with the body's (fold-invariant) height. */
export function defaultPxPerMm(body: BodyDims, workAreaHeight: number): number {
  return (0.85 * workAreaHeight) / body.heightMm;
}

export function bodySizePx(body: BodyDims, open: boolean, rotation: 0 | 1 | 2 | 3, pxPerMm: number): { w: number; h: number } {
  const widthMm = open ? body.openWidthMm : body.closedWidthMm;
  const w = Math.round(widthMm * pxPerMm);
  const h = Math.round(body.heightMm * pxPerMm);
  const rotated = rotation === 1 || rotation === 3;
  return rotated ? { w: h, h: w } : { w, h };
}

const MAX_ALIGN_STEP_PX = 16;
const WHOLE_PX_EPSILON = 1e-6;

function coversWholeDevicePixels(cssPx: number, devicePixelRatio: number): boolean {
  const device = cssPx * devicePixelRatio;
  return Math.abs(device - Math.round(device)) < WHOLE_PX_EPSILON;
}

function alignedSide(cssPx: number, devicePixelRatio: number): number {
  for (let step = 0; step <= MAX_ALIGN_STEP_PX; step++) {
    if (coversWholeDevicePixels(cssPx + step, devicePixelRatio)) return cssPx + step;
  }
  return cssPx;
}

/**
 * Grows a whole-CSS-pixel window size by the few pixels it takes to cover a
 * whole number of device pixels, so the canvas maps 1:1 onto the screen at
 * fractional scale factors instead of being resampled a fraction of a pixel.
 * Electron rounds window bounds to whole CSS pixels, so dividing a rounded
 * device size back down would be rounded away again.
 */
export function deviceAlignedSize(size: { w: number; h: number }, devicePixelRatio: number): { w: number; h: number } {
  return { w: alignedSide(size.w, devicePixelRatio), h: alignedSide(size.h, devicePixelRatio) };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Keeps the fixed half's outer edge in place: the right edge at rotation 0,
 * left at 2, top at 1 (turned counter-clockwise), bottom at 3; the other
 * axis stays centred.
 */
export function anchoredRect(current: Rect, next: { w: number; h: number }, rotation: 0 | 1 | 2 | 3): Rect {
  if (rotation === 1 || rotation === 3) {
    const x = current.x + (current.w - next.w) / 2;
    const y = rotation === 1 ? current.y : current.y + current.h - next.h;
    return { x, y, w: next.w, h: next.h };
  }
  const y = current.y + (current.h - next.h) / 2;
  const x = rotation === 2 ? current.x : current.x + current.w - next.w;
  return { x, y, w: next.w, h: next.h };
}

/**
 * Keeps the centre in place, as when the phone turns. The offset is
 * truncated toward zero so that turning back lands on the starting position
 * instead of creeping by a rounding pixel per round trip.
 */
export function centredRect(current: Rect, next: { w: number; h: number }): Rect {
  const x = current.x + Math.trunc((current.w - next.w) / 2);
  const y = current.y + Math.trunc((current.h - next.h) / 2);
  return { x, y, w: next.w, h: next.h };
}

export function unionSize(a: { w: number; h: number }, b: { w: number; h: number }): { w: number; h: number } {
  return { w: Math.max(a.w, b.w), h: Math.max(a.h, b.h) };
}
