import { expect, test } from "vitest";
import { anchoredWindowBounds } from "../../src/main/window-resize";

const AREA = { x: 0, y: 0, width: 1920, height: 1080 };

test("keeps the right edge in place for rotation 0 when the result already fits the work area", () => {
  const current = { x: 1500, y: 100, width: 300, height: 800 };
  const bounds = anchoredWindowBounds(current, { w: 500, h: 800 }, 0, AREA);
  expect(bounds.x + bounds.width).toBe(current.x + current.width);
  expect(bounds.y).toBe(current.y);
});

test("keeps the top edge in place for rotation 1", () => {
  const current = { x: 400, y: 300, width: 800, height: 300 };
  const bounds = anchoredWindowBounds(current, { w: 1000, h: 500 }, 1, AREA);
  expect(bounds.y).toBe(current.y);
});

test("clamps the anchored result back into the work area when growing would push the left edge negative", () => {
  const current = { x: 50, y: 900, width: 100, height: 150 };
  // Anchoring the right edge (unchanged at x 150) would put the left edge
  // at -150 for this width; the clamp must pull it back to 0, giving up the
  // anchor rather than leaving the window partly off-screen.
  const bounds = anchoredWindowBounds(current, { w: 300, h: 200 }, 0, AREA);
  expect(bounds).toEqual({ x: 0, y: 875, width: 300, height: 200 });
});
