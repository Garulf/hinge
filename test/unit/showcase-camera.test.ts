import { expect, test } from "vitest";
import { blendedCamera, SHOWCASE_REST } from "../../src/shared/showcase-camera";

const deg = (d: number) => (d * Math.PI) / 180;

const BASE = {
  workCentre: { x: 0, y: 0, z: 0 },
  workHalfHeight: 0.08,
  subjectCentre: { x: 0.03, y: -0.01, z: 0.002 },
  subjectRadius: 0.107,
  yawDeg: SHOWCASE_REST.yaw,
  pitchDeg: SHOWCASE_REST.pitch,
};

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

test("the showcase rest pose is yaw -28 and pitch 12 degrees", () => {
  expect(SHOWCASE_REST).toEqual({ yaw: -28, pitch: 12 });
});

test("just after t 0 the camera is a near-orthographic 1 degree lens far down +Z, framing what the work view frames", () => {
  const rig = blendedCamera({ ...BASE, t: 1e-9 });
  expect(rig.fovDeg).toBeCloseTo(1, 6);
  expect(rig.target.x).toBeCloseTo(0, 6);
  expect(rig.target.y).toBeCloseTo(0, 6);
  expect(rig.position.x).toBeCloseTo(0, 6);
  expect(rig.position.y).toBeCloseTo(0, 6);
  const d = distance(rig.position, rig.target);
  expect(d * Math.tan(deg(rig.fovDeg) / 2)).toBeCloseTo(BASE.workHalfHeight, 6);
  expect(rig.near).toBeLessThan(d - 0.2);
  expect(rig.far).toBeGreaterThan(d + 0.2);
});

test("at t 1 the camera looks at the phone from the rest angle with an 18 degree lens, the phone's sphere filling 88 percent of the height", () => {
  const rig = blendedCamera({ ...BASE, t: 1 });
  expect(rig.fovDeg).toBe(18);
  expect(rig.target).toEqual(BASE.subjectCentre);
  const d = distance(rig.position, rig.target);
  const sphereHalfAngle = Math.asin(BASE.subjectRadius / d);
  expect(Math.tan(sphereHalfAngle) / Math.tan(deg(9))).toBeCloseTo(0.88, 6);
  const dir = { x: (rig.position.x - rig.target.x) / d, y: (rig.position.y - rig.target.y) / d, z: (rig.position.z - rig.target.z) / d };
  expect(dir.x).toBeCloseTo(Math.sin(deg(-28)) * Math.cos(deg(12)), 6);
  expect(dir.y).toBeCloseTo(Math.sin(deg(12)), 6);
  expect(dir.z).toBeCloseTo(Math.cos(deg(-28)) * Math.cos(deg(12)), 6);
  expect(rig.near).toBeGreaterThan(0);
  expect(rig.near).toBeLessThan(d - BASE.subjectRadius);
  expect(rig.far).toBeGreaterThan(d + BASE.subjectRadius);
});

test("the camera moves smoothly across the blend: no step between close values of t is a jump", () => {
  let previous = blendedCamera({ ...BASE, t: 0.001 });
  for (let i = 2; i <= 1000; i++) {
    const rig = blendedCamera({ ...BASE, t: i / 1000 });
    const previousSpan = distance(previous.position, previous.target) * Math.tan(deg(previous.fovDeg) / 2);
    const span = distance(rig.position, rig.target) * Math.tan(deg(rig.fovDeg) / 2);
    expect(Math.abs(span - previousSpan)).toBeLessThan(0.001);
    expect(distance(rig.target, previous.target)).toBeLessThan(0.001);
    previous = rig;
  }
});
