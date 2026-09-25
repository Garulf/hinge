import { expect, test } from "vitest";
import { anchoredWindowBounds } from "../../src/main/window-resize";

const AREA = { x: 0, y: 0, width: 1920, height: 1080 };

test("keeps the right edge in place for rotation 0 when the result already fits the work area", () => {
  const current = { x: 1500, y: 100, width: 300, height: 800 };
  const bounds = anchoredWindowBounds(current, { w: 500, h: 800 }, 0, 0, AREA);
  expect(bounds.x + bounds.width).toBe(current.x + current.width);
  expect(bounds.y).toBe(current.y);
});

test("keeps the top edge in place for rotation 1", () => {
  const current = { x: 400, y: 300, width: 800, height: 300 };
  const bounds = anchoredWindowBounds(current, { w: 1000, h: 500 }, 1, 1, AREA);
  expect(bounds.y).toBe(current.y);
});

test("clamps the anchored result back into the work area when growing would push the left edge negative", () => {
  const current = { x: 50, y: 900, width: 100, height: 150 };
  // Anchoring the right edge (unchanged at x 150) would put the left edge
  // at -150 for this width; the clamp must pull it back to 0, giving up the
  // anchor rather than leaving the window partly off-screen.
  const bounds = anchoredWindowBounds(current, { w: 300, h: 200 }, 0, 0, AREA);
  expect(bounds).toEqual({ x: 0, y: 875, width: 300, height: 200 });
});

const QHD_125: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 2048, height: 1112 };

function closedPhone(): { w: number; h: number } {
  const pxPerMm = (0.85 * QHD_125.height) / 158.4;
  return { w: Math.round(72.1 * pxPerMm), h: Math.round(158.4 * pxPerMm) };
}

function turned(size: { w: number; h: number }, rotation: 0 | 1 | 2 | 3): { w: number; h: number } {
  return rotation === 1 || rotation === 3 ? { w: size.h, h: size.w } : size;
}

test("rotation round trips leave the window where it started", () => {
  const phone = closedPhone();
  const start = { x: 800, y: 100, width: phone.w, height: phone.h };
  let bounds = start;
  let previous: 0 | 1 | 2 | 3 = 0;
  for (let trip = 0; trip < 10; trip++) {
    for (const rotation of [1, 0, 3, 2, 1, 2, 0] as const) {
      bounds = anchoredWindowBounds(bounds, turned(phone, rotation), rotation, previous, QHD_125);
      previous = rotation;
    }
  }
  expect(Math.abs(bounds.x - start.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.y - start.y)).toBeLessThanOrEqual(1);
  expect(bounds.width).toBe(start.width);
  expect(bounds.height).toBe(start.height);
});

test("a rotation change keeps the window centred instead of anchoring an edge", () => {
  const current = { x: 800, y: 100, width: 431, height: 945 };
  const bounds = anchoredWindowBounds(current, { w: 945, h: 431 }, 1, 0, QHD_125);
  expect(Math.abs(bounds.x + bounds.width / 2 - (current.x + current.width / 2))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(bounds.y + bounds.height / 2 - (current.y + current.height / 2))).toBeLessThanOrEqual(0.5);
});

test("the first request, with no previous rotation, keeps the window centred", () => {
  const current = { x: 800, y: 100, width: 360, height: 760 };
  const bounds = anchoredWindowBounds(current, { w: 430, h: 945 }, 0, null, QHD_125);
  expect(bounds.x).toBe(current.x + (360 - 430) / 2);
});

test("a fold at an unchanged rotation still anchors the fixed half's edge", () => {
  const current = { x: 800, y: 100, width: 431, height: 945 };
  const open = anchoredWindowBounds(current, { w: 859, h: 945 }, 0, 0, QHD_125);
  expect(open.x + open.width).toBe(current.x + current.width);
  const sideways = { x: 800, y: 100, width: 945, height: 431 };
  const openSideways = anchoredWindowBounds(sideways, { w: 945, h: 859 }, 1, 1, QHD_125);
  expect(openSideways.y).toBe(sideways.y);
});
