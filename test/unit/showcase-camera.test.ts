import * as THREE from "three";
import { expect, test } from "vitest";
import { blendedCamera, showcaseReach, type Vec3 } from "../../src/shared/showcase-camera";

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

test("at t 1 the camera looks straight down the work view's centre at the phone's depth, offset along +Z", () => {
  const rig = blendedCamera({ ...BASE, t: 1 });
  expect(rig.position.x).toBeCloseTo(BASE.workCentre.x, 9);
  expect(rig.position.y).toBeCloseTo(BASE.workCentre.y, 9);
  expect(rig.position.z).toBeGreaterThan(CENTRE.z);
  expect(rig.target.x).toBeCloseTo(BASE.workCentre.x, 12);
  expect(rig.target.y).toBeCloseTo(BASE.workCentre.y, 12);
  expect(rig.target.z).toBeCloseTo(CENTRE.z, 12);
});

test("folding or unfolding does not pan the showcase camera: the fixed half stays where the work view lays it out", () => {
  const folded = { min: { ...SUBJECT.min, x: CENTRE.x + HALF.x - 0.072 }, max: { ...SUBJECT.max, z: SUBJECT.max.z + 0.004 } };
  const tented = { min: SUBJECT.min, max: { ...SUBJECT.max, z: SUBJECT.max.z + 0.05 } };
  const open = blendedCamera({ ...BASE, t: 1 });
  for (const subject of [folded, tented]) {
    const rig = blendedCamera({ ...BASE, subject, t: 1 });
    expect(rig.position.x).toBeCloseTo(open.position.x, 12);
    expect(rig.position.y).toBeCloseTo(open.position.y, 12);
    expect(rig.target.x).toBeCloseTo(open.target.x, 12);
    expect(rig.target.y).toBeCloseTo(open.target.y, 12);
  }
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

function furthestTurnedCorner(workCentre: Vec3): number {
  const aspect = 1.1;
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(
    (i) => new THREE.Vector3(i & 1 ? SUBJECT.max.x : SUBJECT.min.x, i & 2 ? SUBJECT.max.y : SUBJECT.min.y, i & 4 ? SUBJECT.max.z : SUBJECT.min.z),
  );
  const centre = new THREE.Vector3(CENTRE.x, CENTRE.y, CENTRE.z);
  const rig = blendedCamera({ ...BASE, workCentre, t: 1 });
  const camera = new THREE.PerspectiveCamera(rig.fovDeg, aspect, rig.near, rig.far);
  camera.position.set(rig.position.x, rig.position.y, rig.position.z);
  camera.lookAt(rig.target.x, rig.target.y, rig.target.z);
  camera.updateMatrixWorld();
  let furthest = 0;
  for (let yaw = -180; yaw < 180; yaw += 5) {
    for (let pitch = -60; pitch <= 60; pitch += 5) {
      const turn = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(deg(-pitch), deg(yaw), 0, "XYZ"));
      for (const corner of corners) {
        const ndc = corner.clone().sub(centre).applyMatrix4(turn).add(centre).project(camera);
        furthest = Math.max(furthest, Math.abs(ndc.x) * aspect * BASE.workHalfHeight, Math.abs(ndc.y) * BASE.workHalfHeight);
      }
    }
  }
  return furthest;
}

test("the showcase's reach bounds every corner of the phone however it is turned, and a turn can come close to it", () => {
  const reach = showcaseReach(SUBJECT, CENTRE, BASE.workHalfHeight);
  const furthest = furthestTurnedCorner(CENTRE);
  expect(furthest).toBeLessThanOrEqual(reach);
  expect(furthest).toBeGreaterThan(0.95 * reach);
});

test("mid-fold, with the phone's centre off the work view's, the showcase's reach still bounds every turned corner", () => {
  expect(furthestTurnedCorner(BASE.workCentre)).toBeLessThanOrEqual(showcaseReach(SUBJECT, BASE.workCentre, BASE.workHalfHeight));
  expect(showcaseReach(SUBJECT, BASE.workCentre, BASE.workHalfHeight)).toBeGreaterThan(showcaseReach(SUBJECT, CENTRE, BASE.workHalfHeight));
});
