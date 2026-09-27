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
 * both views. The camera always looks straight on; the phone turns instead.
 * Only the depth it looks at follows the phone: across it, the camera stays
 * on the work view's centre, since the pose's own centre moves with the
 * hinge and would drag the fixed half along with a fold.
 */
export function blendedCamera(input: {
  t: number;
  workCentre: Vec3;
  workHalfHeight: number;
  subject: Box;
}): CameraRig {
  const { t, subject } = input;
  const fovDeg = lerp(NEAR_ORTHO_FOV_DEG, SHOWCASE_FOV_DEG, t);
  const target = { ...input.workCentre, z: lerp(input.workCentre.z, (subject.min.z + subject.max.z) / 2, t) };
  const distance = subject.max.z - target.z + input.workHalfHeight / Math.tan(rad(fovDeg) / 2);
  const position = { x: target.x, y: target.y, z: target.z + distance };
  return { position, target, fovDeg, near: Math.max(0.01, distance - DEPTH_MARGIN_M), far: distance + DEPTH_MARGIN_M };
}

/**
 * How far from the middle of the window, in the units of workHalfHeight,
 * the showcase can draw any point of the subject however it is turned about
 * its centre: the image of the smallest sphere around that centre holding
 * the subject's box, seen from the showcase camera. That camera stays on the
 * work view's centre, so the sphere can sit off its axis mid-fold.
 */
export function showcaseReach(subject: Box, workCentre: Vec3, workHalfHeight: number): number {
  const centre = lerpVec(subject.min, subject.max, 0.5);
  const radius = Math.hypot(subject.max.x - centre.x, subject.max.y - centre.y, subject.max.z - centre.z);
  const halfFov = rad(SHOWCASE_FOV_DEG) / 2;
  const distance = subject.max.z - centre.z + workHalfHeight / Math.tan(halfFov);
  const offAxis = Math.max(Math.abs(centre.x - workCentre.x), Math.abs(centre.y - workCentre.y));
  const angle = Math.atan2(offAxis, distance) + Math.asin(Math.min(1, radius / Math.hypot(distance, offAxis)));
  return (workHalfHeight * Math.tan(angle)) / Math.tan(halfFov);
}
