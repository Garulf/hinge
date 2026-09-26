import * as THREE from "three";
import { expect, test } from "vitest";
import { blendedCamera, SHOWCASE_LIMITS, SHOWCASE_REST, showcaseReach, type Vec3 } from "../../src/shared/showcase-camera";

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
  yawDeg: SHOWCASE_REST.yaw,
  pitchDeg: SHOWCASE_REST.pitch,
};

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

test("the showcase rest pose is straight on: yaw and pitch both 0", () => {
  expect(SHOWCASE_REST).toEqual({ yaw: 0, pitch: 0 });
});

test("at rest the showcase camera looks straight down the phone's normal, offset along +Z with no yaw or pitch", () => {
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

test("an orbit swings the camera around the phone at the rest distance, so the phone never shrinks or grows", () => {
  const rest = blendedCamera({ ...BASE, t: 1 });
  const restDistance = distance(rest.position, rest.target);
  for (const yaw of [SHOWCASE_LIMITS.yaw[0], -30, 30, SHOWCASE_LIMITS.yaw[1]]) {
    for (const pitch of [SHOWCASE_LIMITS.pitch[0], 0, 20, SHOWCASE_LIMITS.pitch[1]]) {
      const rig = blendedCamera({ ...BASE, t: 1, yawDeg: yaw, pitchDeg: pitch });
      const d = distance(rig.position, rig.target);
      expect(d).toBeCloseTo(restDistance, 12);
      expect(rig.fovDeg).toBe(rest.fovDeg);
      expect((rig.position.x - rig.target.x) / d).toBeCloseTo(Math.sin(deg(yaw)) * Math.cos(deg(pitch)), 9);
      expect((rig.position.y - rig.target.y) / d).toBeCloseTo(Math.sin(deg(pitch)), 9);
      expect((rig.position.z - rig.target.z) / d).toBeCloseTo(Math.cos(deg(yaw)) * Math.cos(deg(pitch)), 9);
      expect(rig.near).toBeLessThan(d - 0.2);
      expect(rig.far).toBeGreaterThan(d + 0.2);
    }
  }
});

test("the camera moves smoothly across the blend: no step between close values of t is a jump", () => {
  for (const orbit of [{ yawDeg: 0, pitchDeg: 0 }, { yawDeg: 50, pitchDeg: -10 }]) {
    let previous = blendedCamera({ ...BASE, ...orbit, t: 0.001 });
    for (let i = 2; i <= 1000; i++) {
      const rig = blendedCamera({ ...BASE, ...orbit, t: i / 1000 });
      const previousSpan = distance(previous.position, previous.target) * Math.tan(deg(previous.fovDeg) / 2);
      const span = distance(rig.position, rig.target) * Math.tan(deg(rig.fovDeg) / 2);
      expect(Math.abs(span - previousSpan)).toBeLessThan(0.001);
      expect(distance(rig.target, previous.target)).toBeLessThan(0.001);
      previous = rig;
    }
  }
});

test("the showcase's reach bounds every corner of the phone however it is turned or orbited, and a turn can come close to it", () => {
  const reach = showcaseReach(SUBJECT, BASE.workHalfHeight);
  const aspect = 1.1;
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(
    (i) => new THREE.Vector3(i & 1 ? SUBJECT.max.x : SUBJECT.min.x, i & 2 ? SUBJECT.max.y : SUBJECT.min.y, i & 4 ? SUBJECT.max.z : SUBJECT.min.z),
  );
  const centre = new THREE.Vector3(CENTRE.x, CENTRE.y, CENTRE.z);
  let furthest = 0;
  for (const orbit of [SHOWCASE_REST, { yaw: SHOWCASE_LIMITS.yaw[1], pitch: SHOWCASE_LIMITS.pitch[1] }, { yaw: SHOWCASE_LIMITS.yaw[0], pitch: SHOWCASE_LIMITS.pitch[0] }]) {
    const rig = blendedCamera({ ...BASE, t: 1, yawDeg: orbit.yaw, pitchDeg: orbit.pitch });
    const camera = new THREE.PerspectiveCamera(rig.fovDeg, aspect, rig.near, rig.far);
    camera.position.set(rig.position.x, rig.position.y, rig.position.z);
    camera.lookAt(rig.target.x, rig.target.y, rig.target.z);
    camera.updateMatrixWorld();
    for (let yaw = -180; yaw < 180; yaw += 5) {
      for (let pitch = -60; pitch <= 60; pitch += 5) {
        const turn = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(deg(-pitch), deg(yaw), 0, "XYZ"));
        for (const corner of corners) {
          const ndc = corner.clone().sub(centre).applyMatrix4(turn).add(centre).project(camera);
          furthest = Math.max(furthest, Math.abs(ndc.x) * aspect * BASE.workHalfHeight, Math.abs(ndc.y) * BASE.workHalfHeight);
        }
      }
    }
  }
  expect(furthest).toBeLessThanOrEqual(reach);
  expect(furthest).toBeGreaterThan(0.95 * reach);
});
