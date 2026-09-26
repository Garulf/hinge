import * as THREE from "three";
import { expect, test } from "vitest";
import { clampModelAngles, MODEL_REST, ModelRotation, RotateGesture, turnFitScale, turnPoint } from "../../src/shared/model-rotation";

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

test("turnPoint turns like the scene's Euler: -pitch about X after yaw about Y", () => {
  const angles = { yaw: 24, pitch: 12 };
  const matrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(-angles.pitch), THREE.MathUtils.degToRad(angles.yaw), 0, "XYZ"));
  for (const p of [
    { x: 0.08, y: 0.07, z: 0.003 },
    { x: -0.02, y: 0.05, z: -0.006 },
  ]) {
    const expected = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(matrix);
    const turned = turnPoint(p, angles);
    expect(turned.x).toBeCloseTo(expected.x, 12);
    expect(turned.y).toBeCloseTo(expected.y, 12);
    expect(turned.z).toBeCloseTo(expected.z, 12);
  }
});

/** The open phone in landscape, about 159 by 145 mm and 9 mm deep with the camera bump, filling its window. */
const OPEN_LANDSCAPE = { min: { x: -0.0795, y: -0.0725, z: -0.006 }, max: { x: 0.0795, y: 0.0725, z: 0.003 } };

/** What an orthographic camera looking down -Z sees: clip = projection times view, column-major like Matrix4.elements. */
function orthoClip(frame: { minX: number; maxX: number; minY: number; maxY: number }): number[] {
  const camera = new THREE.OrthographicCamera(frame.minX, frame.maxX, frame.maxY, frame.minY, 0.01, 1);
  camera.position.z = 0.5;
  camera.updateMatrixWorld();
  return new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).toArray();
}

const ITS_WINDOW = orthoClip({ minX: -0.0795, maxX: 0.0795, minY: -0.0725, maxY: 0.0725 });

function projectedCorners(box: typeof OPEN_LANDSCAPE, clip: number[], angles: { yaw: number; pitch: number }, scale: number): { x: number; y: number }[] {
  const c = new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
  const matrix = new THREE.Matrix4().fromArray(clip);
  const corners: { x: number; y: number }[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        const q = turnPoint({ x: x - c.x, y: y - c.y, z: z - c.z }, angles);
        const p = new THREE.Vector4(c.x + q.x * scale, c.y + q.y * scale, c.z + q.z * scale, 1).applyMatrix4(matrix);
        corners.push({ x: p.x / p.w, y: p.y / p.w });
      }
    }
  }
  return corners;
}

test("the fit is exactly 1 at rest, even for a box bigger than the view", () => {
  expect(turnFitScale(OPEN_LANDSCAPE, ITS_WINDOW, MODEL_REST)).toBe(1);
  expect(turnFitScale(OPEN_LANDSCAPE, orthoClip({ minX: -0.01, maxX: 0.01, minY: -0.01, maxY: 0.01 }), { yaw: 0, pitch: 0 })).toBe(1);
});

test("an open landscape plate turned to 24,12 in the work view shrinks just enough to keep its turned corners inside the window", () => {
  const s = turnFitScale(OPEN_LANDSCAPE, ITS_WINDOW, { yaw: 24, pitch: 12 });
  expect(s).toBeLessThan(0.97);
  expect(s).toBeGreaterThan(0.85);
  const corners = projectedCorners(OPEN_LANDSCAPE, ITS_WINDOW, { yaw: 24, pitch: 12 }, s);
  expect(Math.max(...corners.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))))).toBeCloseTo(1, 9);
});

test("the fit is never above 1, and a box with room to spare is not shrunk", () => {
  for (let yaw = -75; yaw <= 75; yaw += 15) {
    for (let pitch = -60; pitch <= 60; pitch += 15) {
      expect(turnFitScale(OPEN_LANDSCAPE, ITS_WINDOW, { yaw, pitch })).toBeLessThanOrEqual(1);
    }
  }
  const roomy = orthoClip({ minX: -0.2, maxX: 0.2, minY: -0.2, maxY: 0.2 });
  expect(turnFitScale(OPEN_LANDSCAPE, roomy, { yaw: 24, pitch: 12 })).toBe(1);
});

test("the fit tends to 1 as the angles go to 0, so the reset spring lands without a jump", () => {
  let last = 0;
  for (const k of [1, 0.5, 0.1, 0.01, 0.001]) {
    const s = turnFitScale(OPEN_LANDSCAPE, ITS_WINDOW, { yaw: 24 * k, pitch: 12 * k });
    expect(s).toBeGreaterThanOrEqual(last);
    last = s;
  }
  expect(last).toBeGreaterThan(0.9995);
});

test("each side may reach as far as the rest pose already does, or the view's edge, whichever is further", () => {
  const deep = { min: { x: 0, y: -0.05, z: -0.03 }, max: { x: 0.1, y: 0.05, z: 0.03 } };
  const tilted = { yaw: 0, pitch: 30 };
  expect(turnFitScale(deep, orthoClip({ minX: 0, maxX: 0.1, minY: -0.05, maxY: 0.05 }), tilted)).toBeLessThan(0.9);
  expect(turnFitScale(deep, orthoClip({ minX: 0, maxX: 0.1, minY: -0.2, maxY: 0.2 }), tilted)).toBe(1);
  expect(turnFitScale(deep, orthoClip({ minX: 0, maxX: 0.1, minY: -0.05, maxY: 0.2 }), tilted)).toBeLessThan(0.9);
});

function showcaseClip(orbitYawDeg: number): number[] {
  const camera = new THREE.PerspectiveCamera(18, 1096 / 892, 0.3, 1.3);
  const d = 0.8;
  camera.position.set(d * Math.sin(THREE.MathUtils.degToRad(orbitYawDeg)), d * Math.sin(THREE.MathUtils.degToRad(12)), d * Math.cos(THREE.MathUtils.degToRad(orbitYawDeg)));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).toArray();
}

test("through a perspective showcase camera a turn that fits is left alone, and one that would leave the view shrinks until it touches the edge", () => {
  const phone = { min: { x: -0.0718, y: -0.0795, z: -0.006 }, max: { x: 0.0718, y: 0.0795, z: 0.003 } };
  const clip = showcaseClip(-28);
  expect(turnFitScale(phone, clip, MODEL_REST)).toBe(1);
  expect(turnFitScale(phone, clip, { yaw: 30, pitch: 0 })).toBe(1);

  const tight = showcaseClip(-28).map((v, i) => (i % 4 === 0 || i % 4 === 1 ? v * 2.2 : v));
  const turned = { yaw: -60, pitch: 45 };
  const s = turnFitScale(phone, tight, turned);
  expect(s).toBeLessThan(1);
  const corners = projectedCorners(phone, tight, turned, s);
  const rest = projectedCorners(phone, tight, MODEL_REST, 1);
  const bound = (pick: (p: { x: number; y: number }) => number, sign: number) => Math.max(1, ...rest.map((p) => sign * pick(p)));
  for (const p of corners) {
    expect(p.x).toBeLessThanOrEqual(bound((q) => q.x, 1) + 1e-9);
    expect(-p.x).toBeLessThanOrEqual(bound((q) => q.x, -1) + 1e-9);
    expect(p.y).toBeLessThanOrEqual(bound((q) => q.y, 1) + 1e-9);
    expect(-p.y).toBeLessThanOrEqual(bound((q) => q.y, -1) + 1e-9);
  }
});
