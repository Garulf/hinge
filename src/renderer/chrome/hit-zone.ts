import type { BodyDims } from "../../shared/layout";
import type { Rotation } from "../../shared/screen-uv";

export interface Size {
  w: number;
  h: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MENU_EDGE_PX = 24;
const FALLBACK_BEZEL_MM = 4;
const PILL_MIN_PX = 22;
const PILL_MAX_PX = 32;
export const MENU_HIDE_DELAY_MS = 700;
const PANEL_MARGIN_PX = 8;

/**
 * Where the phone body sits in the window, following the canvas anchoring:
 * the fixed half's outer edge (right at rotation 0, left at 2, top at 1,
 * bottom at 3) with the other axis centred, or centred on both in fullscreen.
 */
export function bodyRectIn(window: Size, body: Size, rotation: Rotation, centred: boolean): Box {
  const cx = (window.w - body.w) / 2;
  const cy = (window.h - body.h) / 2;
  if (centred) return { x: cx, y: cy, ...body };
  switch (rotation) {
    case 0:
      return { x: window.w - body.w, y: cy, ...body };
    case 2:
      return { x: 0, y: cy, ...body };
    case 1:
      return { x: cx, y: 0, ...body };
    case 3:
      return { x: cx, y: window.h - body.h, ...body };
  }
}

/**
 * The depth of the bezel along the window's top edge: the body's short side
 * less the screen's, halved, when upright; its long side less the screen's
 * when turned. Before the model loads a typical 4 mm stands in.
 */
export function topBezelMm(body: BodyDims, open: boolean, rotation: Rotation, screenMm: { w: number; h: number } | null): number {
  if (!screenMm) return FALLBACK_BEZEL_MM;
  const sideways = rotation === 1 || rotation === 3;
  const bodyAcross = sideways ? (open ? body.openWidthMm : body.closedWidthMm) : body.heightMm;
  const screenAcross = sideways ? screenMm.w : screenMm.h;
  return Math.max(1, (bodyAcross - screenAcross) / 2);
}

/** The pill fits inside the bezel, so it never covers the top of the screen, within a size a pointer can still hit. */
export function pillHeightPx(bezelPx: number): number {
  return Math.round(Math.min(PILL_MAX_PX, Math.max(PILL_MIN_PX, bezelPx)));
}

/** The bezel band along the phone's top edge (at most 24 px deep), and only over the phone; the screen below it stays the phone's. */
export function inMenuZone(p: { x: number; y: number }, body: Box, bezelPx: number = MENU_EDGE_PX): boolean {
  const depth = Math.min(MENU_EDGE_PX, bezelPx);
  return p.x >= body.x && p.x <= body.x + body.w && p.y >= body.y && p.y < body.y + depth;
}

/** The hover menu shows while the pointer is in its zone or on the chrome, lingers briefly after, and stays while a panel is open. */
export class MenuVisibility {
  #lastInsideMs: number | null = null;

  pointer(p: { x: number; y: number } | null, body: Box, overChrome: boolean, nowMs: number, bezelPx?: number): void {
    if (overChrome || (p && inMenuZone(p, body, bezelPx))) this.#lastInsideMs = nowMs;
  }

  visible(nowMs: number, panelOpen: boolean): boolean {
    if (panelOpen) return true;
    return this.#lastInsideMs !== null && nowMs - this.#lastInsideMs < MENU_HIDE_DELAY_MS;
  }

  hide(): void {
    this.#lastInsideMs = null;
  }
}

/** A panel hangs below the menu, centred on the phone but kept inside the window. */
export function panelBox(body: Box, window: Size, panel: Size, top: number): Box {
  const x = Math.min(Math.max(PANEL_MARGIN_PX, body.x + (body.w - panel.w) / 2), Math.max(PANEL_MARGIN_PX, window.w - panel.w - PANEL_MARGIN_PX));
  return { x, y: top, w: panel.w, h: panel.h };
}

/** The window size a panel needs to fit below the menu with a margin all round. */
export function sizeForPanel(panel: Size, menuHeight: number): Size {
  return { w: panel.w + 2 * PANEL_MARGIN_PX, h: menuHeight + panel.h + 2 * PANEL_MARGIN_PX };
}
