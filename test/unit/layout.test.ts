import { expect, test } from "vitest";
import { anchoredRect, bodySizePx, defaultPxPerMm, FOLD7_BODY, unionSize, type Rect } from "../../src/shared/layout";

test("FOLD7_BODY matches the measured dimensions", () => {
  expect(FOLD7_BODY).toEqual({ openWidthMm: 143.7, closedWidthMm: 72.1, heightMm: 158.4 });
});

test("defaultPxPerMm fills 85 percent of the work area height", () => {
  const pxPerMm = defaultPxPerMm(FOLD7_BODY, 1400);
  expect(pxPerMm).toBeCloseTo((0.85 * 1400) / FOLD7_BODY.heightMm, 10);
});

test("bodySizePx: height stays constant between open and closed when not rotated", () => {
  const pxPerMm = defaultPxPerMm(FOLD7_BODY, 1400);
  const open = bodySizePx(FOLD7_BODY, true, 0, pxPerMm);
  const closed = bodySizePx(FOLD7_BODY, false, 0, pxPerMm);
  expect(open.h).toBe(closed.h);
  expect(open.w).toBeGreaterThan(closed.w);
  expect(Number.isInteger(open.w) && Number.isInteger(open.h)).toBe(true);
});

test("bodySizePx: default height fills 85 percent of the work area", () => {
  const pxPerMm = defaultPxPerMm(FOLD7_BODY, 1400);
  const size = bodySizePx(FOLD7_BODY, true, 0, pxPerMm);
  expect(Math.abs(size.h - 1400 * 0.85)).toBeLessThanOrEqual(1);
});

test("bodySizePx: rotation 1 and 3 swap width and height, and width stays constant between open and closed", () => {
  const pxPerMm = defaultPxPerMm(FOLD7_BODY, 1400);
  const portrait = bodySizePx(FOLD7_BODY, true, 0, pxPerMm);
  const landscape = bodySizePx(FOLD7_BODY, true, 1, pxPerMm);
  expect(landscape.w).toBe(portrait.h);
  expect(landscape.h).toBe(portrait.w);

  const landscapeOpen = bodySizePx(FOLD7_BODY, true, 3, pxPerMm);
  const landscapeClosed = bodySizePx(FOLD7_BODY, false, 3, pxPerMm);
  expect(landscapeOpen.w).toBe(landscapeClosed.w);
  expect(landscapeOpen.h).toBeGreaterThan(landscapeClosed.h);
});

test("anchoredRect keeps the right edge for rotation 0 when growing and shrinking, and centres height", () => {
  const current: Rect = { x: 100, y: 200, w: 300, h: 800 };

  const grown = anchoredRect(current, { w: 500, h: 800 }, 0);
  expect(grown.x + grown.w).toBe(current.x + current.w);
  expect(grown.y).toBe(current.y);

  const shrunk = anchoredRect(current, { w: 150, h: 800 }, 0);
  expect(shrunk.x + shrunk.w).toBe(current.x + current.w);

  const taller = anchoredRect(current, { w: 300, h: 1000 }, 0);
  expect(taller.y).toBe(current.y - (1000 - current.h) / 2);
});

test("anchoredRect keeps the left edge for rotation 2", () => {
  const current: Rect = { x: 100, y: 200, w: 300, h: 800 };
  const grown = anchoredRect(current, { w: 500, h: 800 }, 2);
  expect(grown.x).toBe(current.x);
  expect(grown.y).toBe(current.y);
});

test("anchoredRect keeps the top edge for rotation 1 and centres width", () => {
  const current: Rect = { x: 100, y: 200, w: 800, h: 300 };
  const grown = anchoredRect(current, { w: 1000, h: 500 }, 1);
  expect(grown.y).toBe(current.y);
  expect(grown.x).toBe(current.x - (1000 - current.w) / 2);
});

test("anchoredRect keeps the bottom edge for rotation 3 and centres width", () => {
  const current: Rect = { x: 100, y: 200, w: 800, h: 300 };
  const grown = anchoredRect(current, { w: 1000, h: 500 }, 3);
  expect(grown.y + grown.h).toBe(current.y + current.h);
  expect(grown.x).toBe(current.x - (1000 - current.w) / 2);
});

test("unionSize takes the maximum of each dimension", () => {
  expect(unionSize({ w: 300, h: 900 }, { w: 500, h: 800 })).toEqual({ w: 500, h: 900 });
});
