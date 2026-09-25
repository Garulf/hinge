import { expect, test } from "vitest";
import { Orbit } from "../../src/shared/orbit";

const LIMITS = { yaw: [-60, 60] as [number, number], pitch: [-10, 45] as [number, number] };

test("drag moves yaw and pitch at 0.3 degrees per pixel", () => {
  const orbit = new Orbit({ yaw: 0, pitch: 0 }, LIMITS);
  orbit.drag(100, 50);
  expect(orbit.tick(0, 0)).toEqual({ yaw: 30, pitch: 15 });
});

test("drag clamps to the yaw and pitch limits on both ends", () => {
  const orbit = new Orbit({ yaw: 0, pitch: 0 }, LIMITS);
  orbit.drag(10_000, 10_000);
  expect(orbit.tick(0, 0)).toEqual({ yaw: 60, pitch: 45 });

  const other = new Orbit({ yaw: 0, pitch: 0 }, LIMITS);
  other.drag(-10_000, -10_000);
  expect(other.tick(0, 0)).toEqual({ yaw: -60, pitch: -10 });
});

test("holds position after release until 2 s have passed", () => {
  const orbit = new Orbit({ yaw: 0, pitch: 0 }, LIMITS);
  orbit.drag(200, 150); // yaw 60 (clamped), pitch 45 (clamped)
  orbit.release(0);

  let last = orbit.tick(0, 0);
  for (let now = 16; now < 2000; now += 16) last = orbit.tick(now, 16);

  expect(last).toEqual({ yaw: 60, pitch: 45 });
});

test("springs back to rest within 500 ms plus or minus 60 once the 2 s hold elapses", () => {
  const orbit = new Orbit({ yaw: 0, pitch: 0 }, LIMITS);
  orbit.drag(200, 150); // yaw 60, pitch 45, both clamped to their limits
  orbit.release(0);

  for (let now = 16; now < 2000; now += 16) orbit.tick(now, 16);

  let settledAtMs: number | null = null;
  for (let now = 2000; now <= 2000 + 700; now += 16) {
    const pose = orbit.tick(now, 16);
    if (settledAtMs === null && Math.abs(pose.yaw) <= 0.5 && Math.abs(pose.pitch) <= 0.5) {
      settledAtMs = now - 2000;
    }
  }

  expect(settledAtMs).not.toBeNull();
  expect(settledAtMs as number).toBeGreaterThanOrEqual(500 - 60);
  expect(settledAtMs as number).toBeLessThanOrEqual(500 + 60);
});

test("a new drag during the hold or the spring-back cancels it and resumes from the current position", () => {
  const orbit = new Orbit({ yaw: 0, pitch: 0 }, LIMITS);
  orbit.drag(200, 0); // yaw 60
  orbit.release(0);

  for (let now = 16; now <= 2100; now += 16) orbit.tick(now, 16);
  const mid = orbit.tick(2116, 16);
  expect(mid.yaw).toBeLessThan(60); // spring is already under way back toward rest

  orbit.drag(10, 0); // nudge further while springing back
  const afterNudge = orbit.tick(2132, 16);
  expect(afterNudge.yaw).toBeCloseTo(mid.yaw + 3, 1);

  // no further motion without another release: still holding at the nudged position
  const stillHeld = orbit.tick(4132, 16);
  expect(stillHeld.yaw).toBeCloseTo(afterNudge.yaw, 5);
});

test("the spring-back comes to rest exactly on the rest pose", () => {
  const orbit = new Orbit({ yaw: -28, pitch: 12 }, LIMITS);
  orbit.drag(100, -50);
  orbit.release(0);
  let pose = orbit.tick(0, 0);
  for (let now = 16; now <= 5000; now += 16) pose = orbit.tick(now, 16);
  expect(pose).toEqual({ yaw: -28, pitch: 12 });
});
