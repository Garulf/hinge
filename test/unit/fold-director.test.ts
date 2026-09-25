import { expect, test } from "vitest";
import { FoldDirector } from "../../src/shared/fold-director";
import { Spring } from "../../src/shared/spring";
import type { PostureReading } from "../../src/shared/posture";
import type { ScreenClass } from "../../src/shared/fold7";

function reading(partial: Partial<PostureReading>): PostureReading {
  return { stateId: null, posture: null, rotation: null, ...partial };
}

const COVER: ScreenClass = { screen: "cover", rotated: false };
const INNER: ScreenClass = { screen: "inner", rotated: false };
const INNER_ROTATED: ScreenClass = { screen: "inner", rotated: true };

function ticks(director: FoldDirector, n: number, dtMs = 16) {
  let out;
  for (let i = 0; i < n; i++) out = director.tick(dtMs);
  return out!;
}

test("opening from closed: the tent, half, open posture sequence leads the target to 180 while the cover is still lit", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  ticks(director, 20); // let cover brightness settle to 1

  director.posture(reading({ posture: "tent" })); // device state 1: no lead yet
  let out = ticks(director, 5);
  expect(out.angle).toBeCloseTo(0, 0);

  director.posture(reading({ posture: "half" })); // device state 2: posture leads to 180
  out = ticks(director, 5);
  expect(out.angle).toBeGreaterThan(0);

  director.posture(reading({ posture: "open" })); // device state 3: still leading, stream hasn't spoken yet
  out = ticks(director, 40);

  expect(out.lit).toBe("cover");
  expect(out.coverBrightness).toBeCloseTo(1, 3);
  expect(out.angle).toBeGreaterThan(90); // moving toward 180 already, before the stream says inner
});

test("stream class change hands off: cover fades out over 200 ms, inner starts at 0 until firstFrame", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  ticks(director, 30); // cover brightness settled at 1
  director.posture(reading({ posture: "open" }));
  ticks(director, 10);

  director.streamClass(INNER);
  let out = director.tick(16);
  expect(out.lit).toBe("inner");
  expect(out.innerBrightness).toBe(0);
  expect(out.coverBrightness).toBeLessThan(1); // fading out already

  // step through the 200 ms fade-out window
  out = ticks(director, 12, 16); // ~192 ms more
  expect(out.coverBrightness).toBeCloseTo(0, 1);
  expect(out.innerBrightness).toBe(0); // still waiting for firstFrame

  director.firstFrame();
  out = director.tick(16);
  expect(out.innerBrightness).toBeGreaterThan(0);
  out = ticks(director, 12, 16); // ~192 ms of the 150 ms fade-in window
  expect(out.innerBrightness).toBeCloseTo(1, 1);
});

test("fold reversed mid-animation: retargeting to 0 moves smoothly with no jump", () => {
  // Reference: the same spring (same default settleMs), stepped forward
  // 0 -> 180 without interruption, bounds the largest per-tick change any
  // untroubled forward motion makes; the reversal must never exceed it.
  const forward = new Spring({ value: 0, settleMs: 450 });
  forward.target = 180;
  let maxForwardStep = 0;
  let previousForward = forward.value;
  for (let i = 0; i < 30; i++) {
    forward.step(16);
    maxForwardStep = Math.max(maxForwardStep, Math.abs(forward.value - previousForward));
    previousForward = forward.value;
  }

  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  ticks(director, 20);
  director.streamClass(INNER);
  director.firstFrame();

  const midway = ticks(director, 10); // partway toward 180
  expect(midway.angle).toBeGreaterThan(0);
  expect(midway.angle).toBeLessThan(180);

  director.streamClass(COVER); // stream reverses before settling
  let previous = midway.angle;
  let maxDrop = 0;
  for (let i = 0; i < 30; i++) {
    const out = director.tick(16);
    maxDrop = Math.max(maxDrop, previous - out.angle);
    previous = out.angle;
  }
  expect(maxDrop).toBeLessThanOrEqual(maxForwardStep + 1e-6);
});

test("stream says cover while posture says open: the stream has the final word, target is 0", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  director.posture(reading({ posture: "open" }));
  director.streamClass(COVER); // stream re-confirms cover despite posture

  const out = ticks(director, 60);
  expect(out.lit).toBe("cover");
  expect(out.angle).toBeCloseTo(0, 0);
});

test("a rotation-only reading (same posture) does not re-lead a target the stream already reclaimed", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  director.posture(reading({ posture: "open" })); // leads to 180 before the stream catches up
  director.streamClass(COVER); // stream reclaims: target back to 0

  director.posture(reading({ posture: "open", rotation: 1 })); // same posture value, only rotation changed
  const out = ticks(director, 60);
  expect(out.lit).toBe("cover");
  expect(out.angle).toBeCloseTo(0, 0);
});

test("mirror: a rotation-only reading does not re-lead a target the stream already reclaimed toward inner", () => {
  const director = new FoldDirector();
  director.streamClass(INNER);
  director.firstFrame();
  director.posture(reading({ posture: "closed" })); // leads to 0 before the stream catches up
  director.streamClass(INNER); // stream reclaims: target back to 180

  director.posture(reading({ posture: "closed", rotation: 2 })); // same posture value, only rotation changed
  const out = ticks(director, 60);
  expect(out.lit).toBe("inner");
  expect(out.angle).toBeGreaterThanOrEqual(179);
});

test("before any stream class, posture sets the work target directly", () => {
  const director = new FoldDirector();
  director.posture(reading({ posture: "open" }));
  const out = ticks(director, 60);
  expect(out.lit).toBeNull();
  expect(out.angle).toBeGreaterThanOrEqual(179);
});

test("after streamEnded, the target follows the most recently announced class and posture still only leads", () => {
  const director = new FoldDirector();
  director.streamClass(INNER);
  director.firstFrame();
  const beforeEnd = ticks(director, 60);
  expect(beforeEnd.angle).toBeGreaterThanOrEqual(179);

  director.streamEnded();
  const afterEnd = director.tick(16);
  expect(afterEnd.lit).toBeNull();
  expect(afterEnd.angle).toBeGreaterThanOrEqual(179); // still following the last announced class

  director.posture(reading({ posture: "closed" })); // leads toward 0, same as while lit
  const out = ticks(director, 60);
  expect(out.angle).toBeCloseTo(0, 0);
});

test("tent posture keeps the work angle at 0 with no badge", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  director.posture(reading({ posture: "tent" }));

  const out = ticks(director, 40);
  expect(out.angle).toBeCloseTo(0, 0);
  expect(out.badge).toBeNull();
});

test("half posture with the inner screen lit sets the flex badge", () => {
  const director = new FoldDirector();
  director.streamClass(INNER);
  director.firstFrame();
  director.posture(reading({ posture: "half" }));

  const out = director.tick(16);
  expect(out.badge).toBe("flex");
});

test("half posture without the inner screen lit has no badge", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  director.posture(reading({ posture: "half" }));

  const out = director.tick(16);
  expect(out.badge).toBeNull();
});

test("rotation comes from posture when known", () => {
  const director = new FoldDirector();
  director.streamClass(INNER_ROTATED);
  director.posture(reading({ rotation: 3 }));

  expect(director.tick(16).rotation).toBe(3);
});

test("an unrotated class forces rotation to 0 even with a stale posture rotation", () => {
  const director = new FoldDirector();
  director.posture(reading({ rotation: 1 }));
  director.streamClass(COVER); // not rotated

  expect(director.tick(16).rotation).toBe(0);
});

test("a rotated class with no known posture rotation defaults to 1", () => {
  const director = new FoldDirector();
  director.streamClass(INNER_ROTATED);

  expect(director.tick(16).rotation).toBe(1);
});

test("a rotated class with a posture rotation of 0 or 2 (invalid for a rotated class) yields 1", () => {
  const zero = new FoldDirector();
  zero.streamClass(INNER_ROTATED);
  zero.posture(reading({ rotation: 0 }));
  expect(zero.tick(16).rotation).toBe(1);

  const two = new FoldDirector();
  two.streamClass(INNER_ROTATED);
  two.posture(reading({ rotation: 2 }));
  expect(two.tick(16).rotation).toBe(1);
});

test("innerVisible is false below 25 degrees and true at or above it", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();

  expect(director.tick(16).innerVisible).toBe(false);

  director.streamClass(INNER);
  director.firstFrame();
  const out = ticks(director, 60);
  expect(out.angle).toBeGreaterThanOrEqual(25);
  expect(out.innerVisible).toBe(true);
});

test("settled is false while a fade is in progress and true once everything settles", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  const mid = director.tick(16);
  expect(mid.settled).toBe(false);

  const settled = ticks(director, 60);
  expect(settled.settled).toBe(true);
});

test("true angle is clamped to at most 30 while the cover is lit even if posture reports more", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  director.posture(reading({ posture: "open" }));

  const out = ticks(director, 60);
  expect(out.trueAngle).toBeLessThanOrEqual(30.5);
});

test("true angle is clamped to at least 100 while the inner screen is lit even if posture reports less", () => {
  const director = new FoldDirector();
  director.streamClass(INNER);
  director.firstFrame();
  director.posture(reading({ posture: "closed" }));

  const out = ticks(director, 60);
  expect(out.trueAngle).toBeGreaterThanOrEqual(99.5);
});
