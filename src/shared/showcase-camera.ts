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

export const SHOWCASE_REST = { yaw: -28, pitch: 12 };
export const SHOWCASE_LIMITS: { yaw: [number, number]; pitch: [number, number] } = { yaw: [-60, 60], pitch: [-10, 45] };

const SHOWCASE_FOV_DEG = 30;
const NEAR_ORTHO_FOV_DEG = 1;
const SPHERE_FILL = 0.7;
const DEPTH_MARGIN_M = 0.5;

const rad = (deg: number) => (deg * Math.PI) / 180;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Half the height the showcase lens sees at the phone's centre, for a
 * distance at which the phone's bounding sphere spans SPHERE_FILL of the
 * frame height.
 */
function showcaseHalfHeight(radius: number): number {
  const halfFov = rad(SHOWCASE_FOV_DEG) / 2;
  const sphereHalfAngle = Math.atan(SPHERE_FILL * Math.tan(halfFov));
  return (radius / Math.sin(sphereHalfAngle)) * Math.tan(halfFov);
}

/**
 * The perspective camera between the work view (t 0) and the showcase (t 1).
 * The lens widens from a near-orthographic 1 degree to 30 while the height
 * it frames at the point it looks at eases from the work view's to the
 * showcase's, so the image leaves the orthographic work view without a jump.
 */
export function blendedCamera(input: {
  t: number;
  workCentre: Vec3;
  workHalfHeight: number;
  subjectCentre: Vec3;
  subjectRadius: number;
  yawDeg: number;
  pitchDeg: number;
}): CameraRig {
  const { t } = input;
  const fovDeg = lerp(NEAR_ORTHO_FOV_DEG, SHOWCASE_FOV_DEG, t);
  const halfHeight = lerp(input.workHalfHeight, showcaseHalfHeight(input.subjectRadius), t);
  const distance = halfHeight / Math.tan(rad(fovDeg) / 2);
  const target = {
    x: lerp(input.workCentre.x, input.subjectCentre.x, t),
    y: lerp(input.workCentre.y, input.subjectCentre.y, t),
    z: lerp(input.workCentre.z, input.subjectCentre.z, t),
  };
  const yaw = rad(input.yawDeg * t);
  const pitch = rad(input.pitchDeg * t);
  const position = {
    x: target.x + distance * Math.sin(yaw) * Math.cos(pitch),
    y: target.y + distance * Math.sin(pitch),
    z: target.z + distance * Math.cos(yaw) * Math.cos(pitch),
  };
  return { position, target, fovDeg, near: Math.max(0.01, distance - DEPTH_MARGIN_M), far: distance + DEPTH_MARGIN_M };
}
