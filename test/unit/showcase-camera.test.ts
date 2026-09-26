import { expect, test } from "vitest";
import { blendedCamera, type Vec3 } from "../../src/shared/showcase-camera";

const deg = (d: number) => (d * Math.PI) / 180;

const CENTRE = { x: 0.03, y: -0.01, z: 0.002 };
const HALF = { x: 0.1437 / 2, y: 0.1584 / 2, z: 0.0089 / 2 };
const SUBJECT = {
  min: { x: CENTRE.x - HALF.x, y: CENTRE.y - HALF.y, z: CENTRE.z - HALF.z },
  max: { x: CENTRE.x + HALF.x, y: CENTRE.y + HALF.y, z: CENTRE.z + HALF.z },
};

const BASE = {
  workCentre: { x: 0, y: 0, z: 0 },
  workHalfHeight: HALF.y,
  subject: SUBJECT,
};

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

test("at t 1 the camera looks straight down the phone's normal, offset along +Z", () => {
  const rig = blendedCamera({ ...BASE, t: 1 });
  expect(rig.position.x).toBeCloseTo(CENTRE.x, 9);
  expect(rig.position.y).toBeCloseTo(CENTRE.y, 9);
  expect(rig.position.z).toBeGreaterThan(CENTRE.z);
  expect(rig.target.x).toBeCloseTo(CENTRE.x, 12);
  expect(rig.target.y).toBeCloseTo(CENTRE.y, 12);
  expect(rig.target.z).toBeCloseTo(CENTRE.z, 12);
});

test("just after t 0 the camera is a near-orthographic 1 degree lens far down +Z, framing what the work view frames at the front of the phone", () => {
  const rig = blendedCamera({ ...BASE, t: 1e-9 });
  expect(rig.fovDeg).toBeCloseTo(1, 6);
  expect(rig.target.x).toBeCloseTo(0, 6);
  expect(rig.target.y).toBeCloseTo(0, 6);
  expect(rig.position.x).toBeCloseTo(0, 6);
  expect(rig.position.y).toBeCloseTo(0, 6);
  const toFront = rig.position.z - SUBJECT.max.z;
  expect(toFront * Math.tan(deg(rig.fovDeg) / 2)).toBeCloseTo(BASE.workHalfHeight, 9);
  const d = distance(rig.position, rig.target);
  expect(rig.near).toBeLessThan(d - 0.2);
  expect(rig.far).toBeGreaterThan(d + 0.2);
});

test("at t 1 the 18 degree lens keeps the work view's scale at the front of the phone, so the phone is the same size in both views", () => {
  const rig = blendedCamera({ ...BASE, t: 1 });
  expect(rig.fovDeg).toBe(18);
  const toFront = rig.position.z - SUBJECT.max.z;
  expect(toFront * Math.tan(deg(9))).toBeCloseTo(BASE.workHalfHeight, 12);
  expect(rig.near).toBeGreaterThan(0);
  expect(rig.near).toBeLessThan(toFront);
  expect(rig.far).toBeGreaterThan(rig.position.z - SUBJECT.min.z);
});

test("in fullscreen, with room to spare, the showcase still keeps the work view's scale", () => {
  const rig = blendedCamera({ ...BASE, workHalfHeight: 0.2, t: 1 });
  expect((rig.position.z - SUBJECT.max.z) * Math.tan(deg(9))).toBeCloseTo(0.2, 12);
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
