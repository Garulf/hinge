import { expect, test } from "vitest";
import { ViewTransition } from "../../src/shared/view-transition";

function run(vt: ViewTransition, totalMs: number, dtMs: number): { t: number; active: boolean } {
  let elapsed = 0;
  let last = { t: 0, active: false };
  while (elapsed < totalMs) {
    last = vt.tick(dtMs);
    elapsed += dtMs;
  }
  return last;
}

test("starts at rest, work, t 0, inactive", () => {
  const vt = new ViewTransition();
  expect(vt.tick(16)).toEqual({ t: 0, active: false });
});

test("a full 600 ms transition to showcase reaches t 1 and goes inactive", () => {
  const vt = new ViewTransition();
  vt.toggle();
  const result = run(vt, 616, 16);
  expect(result.t).toBe(1);
  expect(result.active).toBe(false);
});

test("mid transition (300 ms of 600) sits at the ease curve's symmetric midpoint", () => {
  const vt = new ViewTransition();
  vt.toggle();
  let last = { t: 0, active: true };
  for (let elapsed = 0; elapsed < 300; elapsed += 16) last = vt.tick(16);
  expect(last.t).toBeCloseTo(0.5, 1);
  expect(last.active).toBe(true);
});

test("the ease curve is symmetric: t at p and 1 - p sum to 1", () => {
  const forward = new ViewTransition({ durationMs: 600 });
  forward.toggle();
  const samples: number[] = [];
  for (let elapsed = 0; elapsed < 600; elapsed += 16) samples.push(forward.tick(16).t);

  const early = samples[Math.floor(samples.length * 0.25)];
  const late = samples[Math.floor(samples.length * 0.75)];
  expect(early + late).toBeCloseTo(1, 1);
});

test("toggling mid-way reverses smoothly from the current t instead of jumping", () => {
  const vt = new ViewTransition({ durationMs: 600 });
  vt.toggle();
  let last = { t: 0, active: true };
  for (let elapsed = 0; elapsed < 300; elapsed += 16) last = vt.tick(16);
  const tBeforeReverse = last.t;

  vt.toggle();
  const afterReverse = vt.tick(16);

  expect(afterReverse.t).toBeLessThan(tBeforeReverse);
  expect(tBeforeReverse - afterReverse.t).toBeLessThan(0.1);
});

test("a full round trip returns exactly to t 0, inactive", () => {
  const vt = new ViewTransition({ durationMs: 600 });
  vt.toggle();
  run(vt, 616, 16);
  vt.toggle();
  const back = run(vt, 616, 16);
  expect(back).toEqual({ t: 0, active: false });
});

test("setTarget eases to a view, and instant lands on it at once", () => {
  const vt = new ViewTransition();
  vt.setTarget("showcase");
  expect(vt.tick(300)).toMatchObject({ active: true });
  vt.setTarget("work", { instant: true });
  expect(vt.target).toBe("work");
  expect(vt.tick(0)).toEqual({ t: 0, active: false });
  vt.setTarget("showcase", { instant: true });
  expect(vt.tick(16)).toEqual({ t: 1, active: false });
});
