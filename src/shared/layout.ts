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
