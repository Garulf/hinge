import { expect, test } from "vitest";
import { clampToWorkArea } from "../../src/shared/clamp-bounds";

const AREA = { x: 0, y: 0, width: 1920, height: 1080 };

test("leaves a window that already fits within the work area unchanged", () => {
  expect(clampToWorkArea({ x: 100, y: 100, width: 400, height: 800 }, AREA)).toEqual({ x: 100, y: 100, width: 400, height: 800 });
});

test("pulls a window back that was recentered past the right and bottom edges", () => {
  expect(clampToWorkArea({ x: 1800, y: 1000, width: 400, height: 800 }, AREA)).toEqual({ x: 1520, y: 280, width: 400, height: 800 });
});

test("pulls a window back that was recentered past the left and top edges", () => {
  expect(clampToWorkArea({ x: -200, y: -50, width: 400, height: 800 }, AREA)).toEqual({ x: 0, y: 0, width: 400, height: 800 });
});

test("a window taller or wider than the whole work area is pinned to its origin, not left partly off-screen", () => {
  expect(clampToWorkArea({ x: -100, y: -100, width: 2200, height: 1200 }, AREA)).toEqual({ x: 0, y: 0, width: 2200, height: 1200 });
});

test("respects a work area that does not start at the origin (a secondary monitor)", () => {
  const area = { x: 1920, y: 0, width: 1920, height: 1080 };
  expect(clampToWorkArea({ x: 1800, y: -20, width: 400, height: 800 }, area)).toEqual({ x: 1920, y: 0, width: 400, height: 800 });
});
