import { expect, test } from "vitest";
import { isWheelNotch, ScrollSmoother, SMALLEST_SLICE, wheelToScroll } from "../../src/shared/scroll-smoother";

function drain(s: ScrollSmoother, smoothingMs: number, frameMs = 16): { x: number; y: number }[] {
  const slices: { x: number; y: number }[] = [];
  for (let i = 0; i < 1000 && !s.idle; i++) slices.push(s.take(frameMs, smoothingMs));
  return slices;
}

test("wheelToScroll turns a 100 px notch into one scroll unit, scaled by the speed", () => {
  expect(wheelToScroll(100, 100, 1)).toEqual({ x: -1, y: -1 });
  expect(wheelToScroll(50, -100, 2)).toEqual({ x: -1, y: 2 });
});

test("with smoothing off, everything goes out at once", () => {
  const s = new ScrollSmoother();
  s.add(0, -1);
  expect(s.take(16, 0)).toEqual({ x: 0, y: -1 });
  expect(s.idle).toBe(true);
});

test("a notch spreads over several frames, biggest first, and adds up to the whole notch", () => {
  const s = new ScrollSmoother();
  s.add(0, 1);
  const slices = drain(s, 150);
  expect(slices.length).toBeGreaterThan(4);
  expect(slices[0].y).toBeGreaterThan(slices[1].y);
  expect(slices.reduce((sum, d) => sum + d.y, 0)).toBeCloseTo(1, 9);
});

test("a longer smoothing takes more frames", () => {
  const short = new ScrollSmoother();
  const long = new ScrollSmoother();
  short.add(0, 1);
  long.add(0, 1);
  expect(drain(long, 250).length).toBeGreaterThan(drain(short, 80).length);
});

test("no slice is smaller than the phone can scroll by, apart from nothing on an idle axis", () => {
  const s = new ScrollSmoother();
  s.add(0.3, -1);
  for (const slice of drain(s, 250)) {
    for (const v of [slice.x, slice.y]) if (v !== 0) expect(Math.abs(v)).toBeGreaterThanOrEqual(SMALLEST_SLICE - 1e-12);
  }
});

test("notches in the same direction pile up", () => {
  const s = new ScrollSmoother();
  s.add(0, 1);
  s.take(16, 150);
  s.add(0, 1);
  const rest = drain(s, 150);
  expect(rest.reduce((sum, d) => sum + d.y, 0)).toBeGreaterThan(1);
});

test("turning the wheel back drops what was still to come the old way", () => {
  const s = new ScrollSmoother();
  s.add(0, 2);
  s.take(16, 150);
  s.add(0, -1);
  expect(drain(s, 150).reduce((sum, d) => sum + d.y, 0)).toBeCloseTo(-1, 9);
});

test("one message never carries more than the protocol's 16 units", () => {
  const s = new ScrollSmoother();
  s.add(0, 40);
  expect(s.take(16, 0).y).toBe(16);
  expect(s.take(16, 0).y).toBe(16);
  expect(s.take(16, 0).y).toBe(8);
  expect(s.idle).toBe(true);
});

test("a notch on one axis leaves the other axis still easing out", () => {
  const s = new ScrollSmoother();
  s.add(1, 0);
  s.take(16, 150);
  s.add(0, 1);
  expect(drain(s, 150).reduce((sum, d) => sum + d.x, 0)).toBeGreaterThan(0);
});

test("clear drops everything still to come", () => {
  const s = new ScrollSmoother();
  s.add(1, 1);
  s.clear();
  expect(s.idle).toBe(true);
});

test("isWheelNotch tells a mouse wheel's whole notches from a touchpad's fine steps", () => {
  expect(isWheelNotch({ wheelDeltaX: 0, wheelDeltaY: -120 })).toBe(true);
  expect(isWheelNotch({ wheelDeltaX: 240, wheelDeltaY: 0 })).toBe(true);
  expect(isWheelNotch({ wheelDeltaX: 0, wheelDeltaY: -14 })).toBe(false);
  expect(isWheelNotch({ wheelDeltaX: 0, wheelDeltaY: 0 })).toBe(false);
  expect(isWheelNotch({})).toBe(true);
});
