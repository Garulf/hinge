export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraRig {
  position: Vec3;
  target: Vec3;
  fovDeg: number;
  near: number;
  far: number;
}

export const SHOWCASE_REST = { yaw: 0, pitch: 0 };
export const SHOWCASE_LIMITS: { yaw: [number, number]; pitch: [number, number] } = { yaw: [-60, 60], pitch: [-10, 45] };

const SHOWCASE_FOV_DEG = 18;
const NEAR_ORTHO_FOV_DEG = 1;
const DEPTH_MARGIN_M = 0.5;

export interface Box {
  min: Vec3;
  max: Vec3;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpVec = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) });

/**
 * The perspective camera between the work view (t 0) and the showcase (t 1).
 * The lens widens from a near-orthographic 1 degree to 18 while the front of
 * the phone keeps the work view's scale, so the phone is the same size in
 * both views. An orbit swings the camera around the phone at that distance.
 */
export function blendedCamera(input: {
  t: number;
  workCentre: Vec3;
  workHalfHeight: number;
  subject: Box;
  yawDeg: number;
  pitchDeg: number;
}): CameraRig {
  const { t, subject } = input;
  const fovDeg = lerp(NEAR_ORTHO_FOV_DEG, SHOWCASE_FOV_DEG, t);
  const target = lerpVec(input.workCentre, lerpVec(subject.min, subject.max, 0.5), t);
  const distance = subject.max.z - target.z + input.workHalfHeight / Math.tan(rad(fovDeg) / 2);
  const yaw = rad(input.yawDeg * t);
  const pitch = rad(input.pitchDeg * t);
  const position = {
    x: target.x + distance * Math.sin(yaw) * Math.cos(pitch),
    y: target.y + distance * Math.sin(pitch),
    z: target.z + distance * Math.cos(yaw) * Math.cos(pitch),
  };
  return { position, target, fovDeg, near: Math.max(0.01, distance - DEPTH_MARGIN_M), far: distance + DEPTH_MARGIN_M };
}
