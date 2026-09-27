import { expect, test } from "vitest";
import { clampModelAngles, FULL_LOOK_DEG, MODEL_REST, ModelRotation, offAxisDeg, RotateGesture, turnBlend } from "../../src/shared/model-rotation";

test("the angle follows the pointer's offset from the press point at 0.3 degrees per pixel, up tilting the top away", () => {
  const gesture = new RotateGesture();
  gesture.press({ x: 100, y: 100 }, MODEL_REST, 0);
  expect(gesture.move({ x: 150, y: 100 })).toEqual({ yaw: 15, pitch: 0 });
  expect(gesture.move({ x: 200, y: 60 })).toEqual({ yaw: 30, pitch: 12 });
  expect(gesture.move({ x: 100, y: 100 })).toEqual({ yaw: 0, pitch: 0 });
});

test("a drag starts from the angle it is pressed at, so drags accumulate", () => {
  const gesture = new RotateGesture();
  gesture.press({ x: 0, y: 0 }, { yaw: 20, pitch: -10 }, 0);
  expect(gesture.move({ x: 10, y: 10 })).toEqual({ yaw: 23, pitch: -13 });
});

test("pitch is clamped to 60 either way, but yaw is a full 360 turntable that wraps instead of clamping", () => {
  const gesture = new RotateGesture();
  gesture.press({ x: 0, y: 0 }, MODEL_REST, 0);
  expect(gesture.move({ x: 10_000, y: -10_000 })).toEqual({ yaw: 120, pitch: 60 });
  expect(gesture.move({ x: -10_000, y: 10_000 })).toEqual({ yaw: -120, pitch: -60 });
});

test("a drag that carries the yaw past 180 wraps instead of jumping back", () => {
  const gesture = new RotateGesture();
  gesture.press({ x: 0, y: 0 }, { yaw: 170, pitch: 0 }, 0);
  expect(gesture.move({ x: 100, y: 0 })).toEqual({ yaw: -160, pitch: 0 });
});

test("a move before any press, or after release, changes nothing", () => {
  const gesture = new RotateGesture();
  expect(gesture.move({ x: 50, y: 0 })).toBeNull();
  gesture.press({ x: 0, y: 0 }, MODEL_REST, 0);
  gesture.move({ x: 50, y: 0 });
  expect(gesture.release({ x: 50, y: 0 }, 100)).toBe("keep");
  expect(gesture.move({ x: 90, y: 0 })).toBeNull();
});

test("two clicks within 400 ms that stay within 6 px are a double click", () => {
  const gesture = new RotateGesture();
  gesture.press({ x: 10, y: 10 }, MODEL_REST, 0);
  expect(gesture.release({ x: 12, y: 10 }, 80)).toBe("keep");
  gesture.press({ x: 14, y: 13 }, MODEL_REST, 300);
  gesture.move({ x: 15, y: 13 });
  expect(gesture.release({ x: 15, y: 13 }, 380)).toBe("reset");
});

test("a third click after a double click starts a new pair", () => {
  const gesture = new RotateGesture();
  for (const at of [0, 100]) {
    gesture.press({ x: 0, y: 0 }, MODEL_REST, at);
    gesture.release({ x: 0, y: 0 }, at + 20);
  }
  gesture.press({ x: 0, y: 0 }, MODEL_REST, 200);
  expect(gesture.release({ x: 0, y: 0 }, 220)).toBe("keep");
});

test("clicks more than 400 ms apart are not a double click", () => {
  const gesture = new RotateGesture();
  gesture.press({ x: 0, y: 0 }, MODEL_REST, 0);
  gesture.release({ x: 0, y: 0 }, 50);
  gesture.press({ x: 0, y: 0 }, MODEL_REST, 401);
  expect(gesture.release({ x: 0, y: 0 }, 450)).toBe("keep");
});

test("a press that moved past 6 px is a drag, not a click, even if it comes back", () => {
  const gesture = new RotateGesture();
  gesture.press({ x: 0, y: 0 }, MODEL_REST, 0);
  gesture.move({ x: 7, y: 0 });
  gesture.move({ x: 0, y: 0 });
  gesture.release({ x: 0, y: 0 }, 50);
  gesture.press({ x: 0, y: 0 }, MODEL_REST, 100);
  expect(gesture.release({ x: 0, y: 0 }, 150)).toBe("keep");

  gesture.press({ x: 0, y: 0 }, MODEL_REST, 200);
  gesture.move({ x: 0, y: 7 });
  expect(gesture.release({ x: 0, y: 0 }, 250)).toBe("keep");
});

test("a second click more than 6 px from the first is not a double click", () => {
  const gesture = new RotateGesture();
  gesture.press({ x: 0, y: 0 }, MODEL_REST, 0);
  gesture.release({ x: 0, y: 0 }, 50);
  gesture.press({ x: 7, y: 0 }, MODEL_REST, 100);
  expect(gesture.release({ x: 7, y: 0 }, 150)).toBe("keep");
});

test("a cancelled press is neither a click nor a drag, and forgets the first click", () => {
  const gesture = new RotateGesture();
  gesture.press({ x: 0, y: 0 }, MODEL_REST, 0);
  gesture.release({ x: 0, y: 0 }, 50);
  gesture.press({ x: 0, y: 0 }, MODEL_REST, 100);
  gesture.cancel();
  expect(gesture.move({ x: 50, y: 0 })).toBeNull();
  gesture.press({ x: 0, y: 0 }, MODEL_REST, 200);
  expect(gesture.release({ x: 0, y: 0 }, 250)).toBe("keep");
});

test("clampModelAngles wraps yaw into (-180, 180], clamps pitch to 60, and turns non-finite values into rest", () => {
  expect(clampModelAngles({ yaw: 170 + 30, pitch: -100 })).toEqual({ yaw: -160, pitch: -60 });
  expect(clampModelAngles({ yaw: 180, pitch: 0 })).toEqual({ yaw: 180, pitch: 0 });
  expect(clampModelAngles({ yaw: -180, pitch: 0 })).toEqual({ yaw: 180, pitch: 0 });
  expect(clampModelAngles({ yaw: Number.NaN, pitch: 5 })).toEqual({ yaw: 0, pitch: 5 });
});

test("set moves the model at once and stays there", () => {
  const rotation = new ModelRotation();
  rotation.set({ yaw: 30, pitch: -20 });
  expect(rotation.tick(16)).toEqual({ yaw: 30, pitch: -20 });
  expect(rotation.tick(5000)).toEqual({ yaw: 30, pitch: -20 });
  expect(rotation.moving).toBe(false);
});

test("set wraps yaw and clamps pitch to the limits", () => {
  const rotation = new ModelRotation();
  rotation.set({ yaw: -200, pitch: 200 });
  expect(rotation.angles).toEqual({ yaw: 160, pitch: 60 });
});

function settleTime(from: { yaw: number; pitch: number }, within: number): { visibleMs: number; exactMs: number } {
  const rotation = new ModelRotation();
  rotation.set(from);
  rotation.reset();
  let visibleMs: number | null = null;
  for (let t = 16; t <= 3000; t += 16) {
    const { yaw, pitch } = rotation.tick(16);
    if (visibleMs === null && Math.abs(yaw) <= within && Math.abs(pitch) <= within) visibleMs = t;
    if (yaw === 0 && pitch === 0 && !rotation.moving) return { visibleMs: visibleMs ?? t, exactMs: t };
  }
  throw new Error("the reset never landed on rest");
}

test("reset springs back to rest in about 400 ms and lands exactly on 0,0", () => {
  for (const from of [
    { yaw: 30, pitch: 0 },
    { yaw: 45, pitch: -30 },
    { yaw: 75, pitch: 60 },
  ]) {
    const { visibleMs, exactMs } = settleTime(from, 0.5);
    expect(visibleMs).toBeGreaterThanOrEqual(320);
    expect(visibleMs).toBeLessThanOrEqual(460);
    expect(exactMs).toBeLessThan(800);
  }
});

test("reset from 170 or -170 takes the short way home, never travelling the long way round through 180", () => {
  for (const from of [170, -170]) {
    const rotation = new ModelRotation();
    rotation.set({ yaw: from, pitch: 0 });
    rotation.reset();
    let maxTravel = 0;
    for (let t = 16; t <= 3000; t += 16) {
      const { yaw } = rotation.tick(16);
      maxTravel = Math.max(maxTravel, Math.abs(yaw));
      if (yaw === 0 && !rotation.moving) break;
    }
    expect(maxTravel).toBeLessThan(180);
    expect(rotation.angles).toEqual({ yaw: 0, pitch: 0 });
  }
});

test("the reset spring moves smoothly: it starts toward rest without jumping there", () => {
  const rotation = new ModelRotation();
  rotation.set({ yaw: 60, pitch: 0 });
  rotation.reset();
  expect(rotation.moving).toBe(true);
  const first = rotation.tick(16);
  expect(first.yaw).toBeLessThan(60);
  expect(first.yaw).toBeGreaterThan(50);
});

test("setting the angle mid-reset stops the spring there", () => {
  const rotation = new ModelRotation();
  rotation.set({ yaw: 60, pitch: 0 });
  rotation.reset();
  rotation.tick(100);
  rotation.set({ yaw: 10, pitch: 10 });
  expect(rotation.moving).toBe(false);
  expect(rotation.tick(500)).toEqual({ yaw: 10, pitch: 10 });
});

test("another kind of press between two Alt clicks breaks the double click", () => {
  const gesture = new RotateGesture();
  gesture.press({ x: 0, y: 0 }, MODEL_REST, 0);
  gesture.release({ x: 0, y: 0 }, 20);
  gesture.otherPress();
  gesture.press({ x: 0, y: 0 }, MODEL_REST, 100);
  expect(gesture.release({ x: 0, y: 0 }, 120)).toBe("keep");
});

test("the blend is exactly 0 straight on and 1 from the full look's angle", () => {
  expect(turnBlend({ yaw: 0, pitch: 0 })).toBe(0);
  expect(turnBlend({ yaw: FULL_LOOK_DEG, pitch: 0 })).toBe(1);
  expect(turnBlend({ yaw: 180, pitch: 0 })).toBe(1);
  expect(turnBlend({ yaw: 0, pitch: -FULL_LOOK_DEG / 2 })).toBeCloseTo(0.5, 9);
});

test("the blend eases in, so the first degree of a turn hardly changes the look", () => {
  expect(turnBlend({ yaw: 0.3, pitch: 0 })).toBeLessThan(0.001);
  let previous = 0;
  for (let deg = 0.5; deg <= 40; deg += 0.5) {
    const t = turnBlend({ yaw: deg, pitch: 0 });
    expect(t).toBeGreaterThanOrEqual(previous);
    expect(t - previous).toBeLessThan(0.05);
    previous = t;
  }
});

test("off axis combines yaw and pitch into the angle between the screen's normal and the view", () => {
  expect(offAxisDeg({ yaw: 60, pitch: 0 })).toBeCloseTo(60, 9);
  expect(offAxisDeg({ yaw: 0, pitch: -45 })).toBeCloseTo(45, 9);
  expect(offAxisDeg({ yaw: 180, pitch: 0 })).toBeCloseTo(180, 9);
  expect(offAxisDeg({ yaw: 60, pitch: 60 })).toBeCloseTo((Math.acos(0.25) * 180) / Math.PI, 9);
});

test("the smallest turn off rest still moves the look off the work view", () => {
  expect(turnBlend({ yaw: 1e-6, pitch: 0 })).toBeGreaterThan(0);
  expect(turnBlend({ yaw: 0, pitch: 1e-6 })).toBeGreaterThan(0);
});
