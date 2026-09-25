import { expect, test } from "vitest";
import { defaultScale, workLayout } from "../../src/shared/layout";

test("scale 1 maps one stream pixel to one CSS pixel on the screen rect", () => {
  const l = workLayout(1080, 2520, { screen: "cover", rotated: false }, 1);
  expect(l.screen.w).toBeCloseTo(1080, 0);
  expect(l.screen.h).toBeCloseTo(2520, 0);
  expect(l.window.w).toBeGreaterThan(l.screen.w);
  expect(l.window.h).toBeGreaterThan(l.screen.h);
  expect(l.screen.x + l.screen.w).toBeLessThanOrEqual(l.window.w);
});

test("rotated streams swap the body dimensions", () => {
  const l = workLayout(2520, 1080, { screen: "cover", rotated: true }, 0.25);
  expect(l.window.w).toBeGreaterThan(l.window.h);
});

test("default scale fits the body into 85 percent of the work area height", () => {
  const cls = { screen: "inner" as const, rotated: false };
  const s = defaultScale(1968, 2184, cls, 1400);
  expect(Math.abs(workLayout(1968, 2184, cls, s).window.h - 1400 * 0.85)).toBeLessThanOrEqual(1);
});

test("window sizes are whole pixels", () => {
  const l = workLayout(1968, 2184, { screen: "inner", rotated: false }, 0.3333);
  expect(Number.isInteger(l.window.w) && Number.isInteger(l.window.h)).toBe(true);
});
