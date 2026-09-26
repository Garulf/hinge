import { expect, test } from "vitest";
import { AndroidFling } from "../../src/shared/android-fling";

const fling = new AndroidFling(2.625);

test("a fling starts at the speed it was given and comes to rest at its distance", () => {
  const start = fling.at(3000, 0);
  expect(start.travelled).toBe(0);
  expect(start.velocity).toBe(3000);
  expect(fling.at(3000, 1).velocity).toBeCloseTo(3000, -1);
  const end = fling.at(3000, fling.durationMs(3000));
  expect(end.travelled).toBeCloseTo(fling.distance(3000), 6);
  expect(end.velocity).toBe(0);
});

test("matches Android's spline at 420 dpi: 1000 px/s glides about 95 px over about 270 ms", () => {
  expect(fling.distance(1000)).toBeCloseTo(95.5, 0);
  expect(fling.durationMs(1000)).toBeCloseTo(273, -1);
});

test("velocityFor is the inverse of distance", () => {
  for (const d of [30, 168, 900, 4000]) expect(fling.distance(fling.velocityFor(d))).toBeCloseTo(d, 6);
});

test("a fling slows down as it goes and never runs backwards", () => {
  let last = { travelled: 0, velocity: Infinity };
  for (let t = 0; t <= fling.durationMs(2000); t += 10) {
    const now = fling.at(2000, t);
    expect(now.travelled).toBeGreaterThanOrEqual(last.travelled);
    expect(now.velocity).toBeLessThanOrEqual(last.velocity + 1e-6);
    last = now;
  }
});

test("below Android's minimum fling speed the content just stops", () => {
  expect(fling.distance(fling.minVelocity - 1)).toBe(0);
  expect(fling.durationMs(fling.minVelocity - 1)).toBe(0);
});
