import { expect, test } from "vitest";
import { viewWindowSize } from "../../src/shared/view-window";

const WORK = { w: 372, h: 816 };
const SHOWCASE = { w: 999, h: 816 };

test("the work size at t 0 and the showcase size at t 1, exactly", () => {
  expect(viewWindowSize(WORK, SHOWCASE, 0, 1)).toEqual(WORK);
  expect(viewWindowSize(WORK, SHOWCASE, 1, 1)).toEqual(SHOWCASE);
});

test("in between, a device-aligned blend that never outgrows the larger of the two", () => {
  const mid = viewWindowSize(WORK, SHOWCASE, 0.5, 1.25);
  expect((mid.w * 1.25) % 1).toBe(0);
  expect((mid.h * 1.25) % 1).toBe(0);
  expect(mid.w).toBeGreaterThanOrEqual(Math.round((WORK.w + SHOWCASE.w) / 2));
  const nearEnd = viewWindowSize(WORK, { w: 1001, h: 815 }, 0.999, 1.25);
  expect(nearEnd.w).toBeLessThanOrEqual(1001);
  expect(nearEnd.h).toBeLessThanOrEqual(816);
});
