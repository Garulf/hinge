import { expect, test } from "vitest";
import { FOLD7_BODY } from "../../src/shared/layout";
import { fitPxPerMm, MAX_SCALE, MIN_SCALE, nextPxPerMm, pixelPerfectPxPerMm, stepScale, WheelSteps } from "../../src/shared/scale";

test("stepScale moves in 10 percent steps from the default", () => {
  expect(stepScale(1, 1)).toBeCloseTo(1.1);
  expect(stepScale(1, -1)).toBeCloseTo(0.9);
  expect(stepScale(1.1, 1)).toBeCloseTo(1.2);
  expect(stepScale(stepScale(stepScale(1, 1), 1), -1)).toBeCloseTo(1.1);
});

test("stepScale snaps an off-grid scale (after 1:1) onto the next step in that direction", () => {
  expect(stepScale(1.234, 1)).toBeCloseTo(1.3);
  expect(stepScale(1.234, -1)).toBeCloseTo(1.2);
  expect(stepScale(1.2000000001, 1)).toBeCloseTo(1.3);
});

test("stepScale is clamped", () => {
  expect(stepScale(MIN_SCALE, -1)).toBeCloseTo(MIN_SCALE);
  expect(stepScale(MAX_SCALE, 1)).toBeCloseTo(MAX_SCALE);
  expect(stepScale(0.1, 1)).toBeCloseTo(MIN_SCALE);
});

test("WheelSteps turns wheel deltas into whole notches, keeping the remainder", () => {
  const w = new WheelSteps();
  expect(w.add(100)).toBe(1);
  expect(w.add(40)).toBe(0);
  expect(w.add(70)).toBe(1);
  expect(w.add(-250)).toBe(-2);
});

test("WheelSteps drops the remainder when the direction flips", () => {
  const w = new WheelSteps();
  w.add(90);
  expect(w.add(-20)).toBe(0);
  expect(w.add(-80)).toBe(-1);
});

test("fitPxPerMm fits the open body, portrait or landscape, inside the viewport with a margin", () => {
  const portrait = fitPxPerMm(FOLD7_BODY, 0, { w: 1920, h: 1080 });
  expect(portrait * FOLD7_BODY.heightMm).toBeLessThanOrEqual(1080);
  expect(portrait * FOLD7_BODY.heightMm).toBeGreaterThan(0.85 * 1080);
  const landscape = fitPxPerMm(FOLD7_BODY, 1, { w: 1080, h: 1920 });
  expect(landscape * FOLD7_BODY.heightMm).toBeLessThanOrEqual(1920);
  expect(landscape * FOLD7_BODY.openWidthMm).toBeLessThanOrEqual(1080);
});

test("pixelPerfectPxPerMm maps one video pixel onto one device pixel", () => {
  // 2520 video px over a 153.8 mm cover screen on a 1.5x display: 1680 CSS px.
  const pxPerMm = pixelPerfectPxPerMm({ w: 1080, h: 2520 }, { w: 65.9, h: 153.8 }, 1.5);
  expect(pxPerMm * 153.8 * 1.5).toBeCloseTo(2520);
  const rotated = pixelPerfectPxPerMm({ w: 2520, h: 1080 }, { w: 65.9, h: 153.8 }, 1);
  expect(rotated * 153.8).toBeCloseTo(2520);
});

test("nextPxPerMm steps the default size and stops where the body fills the work area", () => {
  expect(nextPxPerMm(5, 5, 1, 10)).toBeCloseTo(5.5);
  expect(nextPxPerMm(5, 5, -1, 10)).toBeCloseTo(4.5);
  expect(nextPxPerMm(5.5, 5, 1, 5.8)).toBeCloseTo(5.8);
  expect(nextPxPerMm(5.8, 5, 1, 5.8)).toBeCloseTo(5.8);
  expect(nextPxPerMm(9, 5, 1, 5.8)).toBe(9);
  expect(nextPxPerMm(9, 5, -1, 5.8)).toBeCloseTo(5.8);
  expect(nextPxPerMm(5 * MIN_SCALE, 5, -1, 10)).toBeCloseTo(5 * MIN_SCALE);
});
