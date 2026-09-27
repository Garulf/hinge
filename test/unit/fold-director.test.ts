import { expect, test, vi } from "vitest";
import { bodyIsOpen, FoldDirector } from "../../src/shared/fold-director";
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

function ticksWithFrames(director: FoldDirector, n: number, dtMs = 16) {
  let out;
  for (let i = 0; i < n; i++) {
    out = director.tick(dtMs);
    director.frame();
  }
  return out!;
}

test("opening from closed: the tent, half, open posture sequence leads the target to 180 while the cover is still lit", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  ticks(director, 70); // the cover has been showing for over a second

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
  ticks(director, 70);
  director.posture(reading({ posture: "open" })); // leads to 180 before the stream catches up
  director.streamClass(COVER); // stream reclaims: target back to 0
  ticks(director, 70); // past the second in which any contradicting posture is ignored anyway

  director.posture(reading({ posture: "open", rotation: 1 })); // same posture value, only rotation changed
  const out = ticks(director, 60);
  expect(out.lit).toBe("cover");
  expect(out.angle).toBeCloseTo(0, 0);
});

test("mirror: a rotation-only reading does not re-lead a target the stream already reclaimed toward inner", () => {
  const director = new FoldDirector();
  director.streamClass(INNER);
  director.firstFrame();
  ticks(director, 70);
  director.posture(reading({ posture: "closed" })); // leads to 0 before the stream catches up
  director.streamClass(INNER); // stream reclaims: target back to 180
  ticks(director, 70); // past the second in which any contradicting posture is ignored anyway

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
  const beforeEnd = ticks(director, 70);
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

test("a rotated class whose posture reading says 0 or 2 keeps the last landscape rotation seen", () => {
  const director = new FoldDirector();
  director.streamClass(INNER_ROTATED);
  director.posture(reading({ rotation: 3 }));
  expect(director.tick(16).rotation).toBe(3);

  director.posture(reading({ rotation: 0 }));
  expect(director.tick(16).rotation).toBe(3);
  director.posture(reading({ rotation: 2 }));
  expect(director.tick(16).rotation).toBe(3);

  director.posture(reading({ rotation: 1 }));
  director.posture(reading({ rotation: 0 }));
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

test("a settled pose reports the exact target angle and brightness", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  ticks(director, 30);
  director.streamClass(INNER);
  director.firstFrame();
  const out = ticks(director, 60);
  expect(out.settled).toBe(true);
  expect(out.angle).toBe(180);
  expect(out.trueAngle).toBe(180);
  expect(out.innerBrightness).toBe(1);
  expect(out.coverBrightness).toBe(0);
});

test("a posture nudge that contradicts a stream class announced within the last second is ignored", () => {
  const director = new FoldDirector();
  director.streamClass(INNER);
  director.firstFrame();
  ticks(director, 70);

  director.streamClass(COVER); // the stream closed the model
  ticks(director, 50); // 800 ms later a stale sample still says open
  director.posture(reading({ posture: "open" }));
  const out = ticks(director, 60);
  expect(out.lit).toBe("cover");
  expect(out.angle).toBe(0);
});

test("a posture that agrees with a stream class announced moments ago keeps the class's target", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  director.posture(reading({ posture: "closed" }));
  ticksWithFrames(director, 70);

  director.streamClass(INNER);
  director.firstFrame();
  ticksWithFrames(director, 6); // about 100 ms: the class is still fresh
  director.posture(reading({ posture: "open" }));
  const out = ticksWithFrames(director, 200);
  expect(out.lit).toBe("inner");
  expect(out.angle).toBe(180);
});

test("a posture nudge that arrives after the fresh-class second still leads", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  ticks(director, 63); // just over 1000 ms
  director.posture(reading({ posture: "open" }));
  const out = ticks(director, 30);
  expect(out.angle).toBeGreaterThan(90);
});

test("a posture lead expires after 1500 ms when frames of the lit class keep arriving, and the target returns to that class", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  ticksWithFrames(director, 70);

  director.posture(reading({ posture: "open" }));
  const leading = ticksWithFrames(director, 90); // 1440 ms: still leading
  expect(leading.angle).toBe(180);

  const expired = ticksWithFrames(director, 70); // past 1500 ms, then settled back
  expect(expired.lit).toBe("cover");
  expect(expired.angle).toBe(0);
});

test("a class change inside the lead window ends the lead: the stream's word stands after 1500 ms", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  ticks(director, 70);

  director.posture(reading({ posture: "open" }));
  ticks(director, 20);
  director.streamClass(INNER);
  director.firstFrame();
  const out = ticks(director, 150);
  expect(out.lit).toBe("inner");
  expect(out.angle).toBe(180);
});

test("before any stream class, a posture target does not expire", () => {
  const director = new FoldDirector();
  director.posture(reading({ posture: "open" }));
  const out = ticks(director, 200);
  expect(out.angle).toBe(180);
});

test("bodyIsOpen: the window sizes open while the hinge moves or the inner screen is about to open", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  expect(bodyIsOpen(ticks(director, 70))).toBe(false);

  director.streamClass(INNER);
  expect(bodyIsOpen(director.tick(0))).toBe(true);
  director.firstFrame();
  expect(bodyIsOpen(ticks(director, 60))).toBe(true);
});

test("bodyIsOpen: closing with the inner class still lit (the cover stays off) sizes closed once the model settles at 0", () => {
  const director = new FoldDirector();
  director.streamClass(INNER);
  director.firstFrame();
  ticks(director, 70);

  director.posture(reading({ posture: "closed" }));
  const moving = ticks(director, 5);
  expect(bodyIsOpen(moving)).toBe(true);
  const closed = ticks(director, 50); // 880 ms into the lead
  expect(closed.lit).toBe("inner");
  expect(closed.angle).toBe(0);
  expect(bodyIsOpen(closed)).toBe(false);
});

test("a posture close with the cover left dark (no frames at all) keeps the closed pose past the lead window", () => {
  const director = new FoldDirector();
  director.streamClass(INNER);
  director.firstFrame();
  ticksWithFrames(director, 70);

  director.posture(reading({ posture: "closed" }));
  const out = ticks(director, 250); // 4 s with the stream silent
  expect(out.lit).toBe("inner");
  expect(out.angle).toBe(0);
});

test("frames that stop within 300 ms of the lead starting do not let it expire", () => {
  const director = new FoldDirector();
  director.streamClass(INNER);
  director.firstFrame();
  ticksWithFrames(director, 70);

  director.posture(reading({ posture: "closed" }));
  ticksWithFrames(director, 17); // frames up to about 270 ms into the lead, then the screen goes dark
  const out = ticks(director, 230);
  expect(out.angle).toBe(0);
});

test("a stream that keeps sending frames of the other class after 300 ms still wins once the lead runs out", () => {
  const director = new FoldDirector();
  director.streamClass(INNER);
  director.firstFrame();
  ticksWithFrames(director, 70);

  director.posture(reading({ posture: "closed" }));
  ticks(director, 25); // 400 ms without frames
  director.frame(); // one frame of the inner class well after the lead began
  const out = ticks(director, 150);
  expect(out.lit).toBe("inner");
  expect(out.angle).toBe(180);
});

test("posture flickering between half and open with the cover lit does not cycle the model open and closed", () => {
  const director = new FoldDirector();
  director.streamClass(COVER);
  director.firstFrame();
  ticksWithFrames(director, 70);

  let posture: "half" | "open" = "half";
  let opens = 0;
  let wasOpen = false;
  let sinceToggleMs = 1900;
  let out = director.tick(0);
  for (let elapsed = 0; elapsed < 15_000; elapsed += 16) {
    if (sinceToggleMs >= 1900) {
      director.posture(reading({ posture }));
      posture = posture === "half" ? "open" : "half";
      sinceToggleMs = 0;
    }
    out = director.tick(16);
    director.frame();
    sinceToggleMs += 16;
    const open = out.angle > 90;
    if (open && !wasOpen) opens++;
    wasOpen = open;
  }
  expect(opens).toBeLessThanOrEqual(1);
  expect(out.lit).toBe("cover");
  expect(out.angle).toBe(0);
});

test("the displayed angle blends from the work angle to the true angle, so turning the phone mid-fold stays continuous", () => {
  const drive = (d: FoldDirector) => {
    d.streamClass(COVER);
    d.firstFrame();
    ticks(d, 70);
    d.posture(reading({ posture: "half" }));
    d.streamClass(INNER);
    d.firstFrame();
  };
  const work = new FoldDirector();
  const showcase = new FoldDirector();
  showcase.setBlend(1);
  const blended = new FoldDirector();
  for (const d of [work, showcase, blended]) drive(d);

  for (let i = 0; i < 60; i++) {
    const blend = Math.min(1, Math.max(0, (i - 5) / 37));
    blended.setBlend(blend);
    const a = work.tick(16).angle;
    const b = showcase.tick(16).angle;
    const out = blended.tick(16);
    expect(out.angle).toBeCloseTo(a + (b - a) * blend, 9);
    expect(out.innerVisible).toBe(out.angle >= 25);
  }
  const rest = ticks(blended, 30);
  expect(rest.angle).toBe(100);
  expect(rest.trueAngle).toBe(100);
});

test("a blend of 1 shows the true angle and 0 the work angle", () => {
  const director = new FoldDirector();
  director.streamClass(INNER);
  director.firstFrame();
  director.posture(reading({ posture: "half" }));
  ticks(director, 70);
  director.setBlend(1);
  expect(director.tick(16).angle).toBe(100);
  director.setBlend(0);
  expect(director.tick(16).angle).toBe(180);
});

test("a lead that runs out with no frames at all asks the stream for frames once, then holds while none come", () => {
  const requestFrames = vi.fn();
  const director = new FoldDirector({ requestFrames });
  director.streamClass(INNER);
  director.firstFrame();
  ticksWithFrames(director, 70);

  director.posture(reading({ posture: "closed" }));
  ticks(director, 90); // 1440 ms: not yet
  expect(requestFrames).not.toHaveBeenCalled();
  const held = ticks(director, 160);
  expect(requestFrames).toHaveBeenCalledOnce();
  expect(held.angle).toBe(0);
});

test("frames that answer the probe let the stream have its word", () => {
  const requestFrames = vi.fn();
  const director = new FoldDirector({ requestFrames });
  director.streamClass(INNER);
  director.firstFrame();
  ticksWithFrames(director, 70);

  director.posture(reading({ posture: "closed" }));
  ticks(director, 100);
  expect(requestFrames).toHaveBeenCalledOnce();
  const out = ticksWithFrames(director, 60);
  expect(out.angle).toBe(180);
  expect(requestFrames).toHaveBeenCalledOnce();
});

test("each new lead may probe once; a class change ends a lead without a probe", () => {
  const requestFrames = vi.fn();
  const director = new FoldDirector({ requestFrames });
  director.streamClass(COVER);
  director.firstFrame();
  ticksWithFrames(director, 70);

  director.posture(reading({ posture: "open" }));
  ticks(director, 20);
  director.streamClass(INNER);
  director.firstFrame();
  ticks(director, 150);
  expect(requestFrames).not.toHaveBeenCalled();

  director.posture(reading({ posture: "closed" }));
  ticks(director, 150);
  director.posture(reading({ posture: "open" }));
  director.posture(reading({ posture: "closed" }));
  ticks(director, 150);
  expect(requestFrames).toHaveBeenCalledTimes(2);
});
