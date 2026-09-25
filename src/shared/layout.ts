import { FOLD7, type ScreenClass, type ScreenSpec } from "./fold7";

export interface WorkLayout {
  window: { w: number; h: number };
  screen: { x: number; y: number; w: number; h: number };
  pxPerMm: number;
  cls: ScreenClass;
}

function specFor(cls: ScreenClass): ScreenSpec {
  return FOLD7[cls.screen];
}

function longSideMm(spec: ScreenSpec): number {
  return Math.max(spec.mm.w, spec.mm.h);
}

function bodyHeightMm(cls: ScreenClass, spec: ScreenSpec): number {
  return cls.rotated ? spec.bodyMm.w : spec.bodyMm.h;
}

function bodyWidthMm(cls: ScreenClass, spec: ScreenSpec): number {
  return cls.rotated ? spec.bodyMm.h : spec.bodyMm.w;
}

export function workLayout(streamW: number, streamH: number, cls: ScreenClass, scale: number): WorkLayout {
  const spec = specFor(cls);
  const streamLongSide = Math.max(streamW, streamH);
  const pxPerMm = (streamLongSide / longSideMm(spec)) * scale;

  const windowW = Math.round(bodyWidthMm(cls, spec) * pxPerMm);
  const windowH = Math.round(bodyHeightMm(cls, spec) * pxPerMm);
  const screenW = Math.round(streamW * scale);
  const screenH = Math.round(streamH * scale);
  const screenX = Math.round((windowW - screenW) / 2);
  const screenY = Math.round((windowH - screenH) / 2);

  return {
    window: { w: windowW, h: windowH },
    screen: { x: screenX, y: screenY, w: screenW, h: screenH },
    pxPerMm,
    cls,
  };
}

export function defaultScale(streamW: number, streamH: number, cls: ScreenClass, workAreaHeight: number): number {
  const spec = specFor(cls);
  const streamLongSide = Math.max(streamW, streamH);
  const pxPerMmAtScale1 = streamLongSide / longSideMm(spec);
  const targetWindowH = workAreaHeight * 0.85;
  return targetWindowH / (bodyHeightMm(cls, spec) * pxPerMmAtScale1);
}

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

export function unionSize(a: { w: number; h: number }, b: { w: number; h: number }): { w: number; h: number } {
  return { w: Math.max(a.w, b.w), h: Math.max(a.h, b.h) };
}
