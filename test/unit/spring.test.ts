import { expect, test } from "vitest";
import { Spring } from "../../src/shared/spring";

function run(spring: Spring, totalMs: number, dtMs: number): void {
  let elapsed = 0;
  while (elapsed < totalMs) {
    spring.step(dtMs);
    elapsed += dtMs;
  }
}

test("a 0 to 180 step settles within 0.5 degrees at 450 ms plus or minus 50 and never overshoots", () => {
  const spring = new Spring({ value: 0, settleMs: 450 });
  spring.target = 180;
  let maxValue = 0;
  let settledAtMs: number | null = null;
  for (let t = 16; t <= 700; t += 16) {
    spring.step(16);
    maxValue = Math.max(maxValue, spring.value);
    if (settledAtMs === null && spring.settled(0.5)) settledAtMs = t;
  }
  expect(maxValue).toBeLessThanOrEqual(180);
  expect(settledAtMs).not.toBeNull();
  expect(settledAtMs as number).toBeGreaterThanOrEqual(400);
  expect(settledAtMs as number).toBeLessThanOrEqual(500);
});

test("retargeting mid-flight moves smoothly with no jump larger than the forward motion's max per-tick change", () => {
  const forward = new Spring({ value: 0, settleMs: 450 });
  forward.target = 180;
  let maxForwardStep = 0;
  let previous = forward.value;
  for (let i = 0; i < 30; i++) {
    forward.step(16);
    maxForwardStep = Math.max(maxForwardStep, Math.abs(forward.value - previous));
    previous = forward.value;
  }

  const reversing = new Spring({ value: 0, settleMs: 450 });
  reversing.target = 180;
  for (let i = 0; i < 15; i++) reversing.step(16);
  reversing.target = 0;
  let valueBefore = reversing.value;
  for (let i = 0; i < 30; i++) {
    reversing.step(16);
    const step = Math.abs(reversing.value - valueBefore);
    expect(step).toBeLessThanOrEqual(maxForwardStep + 1e-6);
    valueBefore = reversing.value;
  }
});

test("variable dt ticks converge to the same value within 1 degree", () => {
  const totalMs = 297; // a common multiple of both tick sizes, so both cover the same simulated time

  const fine = new Spring({ value: 0, settleMs: 450 });
  fine.target = 180;
  run(fine, totalMs, 1);

  const coarse = new Spring({ value: 0, settleMs: 450 });
  coarse.target = 180;
  run(coarse, totalMs, 33);

  expect(Math.abs(fine.value - coarse.value)).toBeLessThan(1);
});

test("snapIfSettled lands exactly on target once settled and leaves a moving spring alone", () => {
  const spring = new Spring({ value: 0, settleMs: 450 });
  spring.target = 180;
  spring.step(100);
  const moving = spring.value;
  spring.snapIfSettled();
  expect(spring.value).toBe(moving);

  spring.step(500);
  expect(spring.value).not.toBe(180);
  spring.snapIfSettled();
  expect(spring.value).toBe(180);
  expect(spring.velocity).toBe(0);
});
