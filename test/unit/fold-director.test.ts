import { expect, test } from "vitest";
import { FoldDirector } from "../../src/shared/fold-director";
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

test("opening from closed: posture leads the target to 180 while the cover is still lit", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  ticks(director, 20); // let cover brightness settle to 1

  director.posture(reading({ posture: "half" }));
  const out = ticks(director, 40);

  expect(out.lit).toBe("cover");
  expect(out.coverBrightness).toBeCloseTo(1, 3);
  expect(out.angle).toBeGreaterThan(0); // moving toward 180 already, before the stream says inner
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
  expect(maxDrop).toBeLessThan(30); // smooth, not a jump
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
