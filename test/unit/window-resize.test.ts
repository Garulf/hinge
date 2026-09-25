import { expect, test } from "vitest";
import { anchoredWindowBounds } from "../../src/main/window-resize";

const AREA = { x: 0, y: 0, width: 1920, height: 1080 };

test("keeps the right edge in place for rotation 0 and clamps to the work area", () => {
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

test("clamps the anchored result back into the work area when it would spill past an edge", () => {
  const current = { x: 1700, y: 900, width: 200, height: 150 };
  const bounds = anchoredWindowBounds(current, { w: 220, h: 200 }, 0, AREA);
  expect(bounds.x).toBeGreaterThanOrEqual(AREA.x);
  expect(bounds.y).toBeGreaterThanOrEqual(AREA.y);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(AREA.x + AREA.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(AREA.y + AREA.height);
});
