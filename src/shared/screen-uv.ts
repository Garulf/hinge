export type ScreenKind = "cover" | "inner";
export type Rotation = 0 | 1 | 2 | 3;

interface Coeffs {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/**
 * x = a*u + b*v + c, y = d*u + e*v + f, per the rotation table in the M3 plan
 * (Display.getRotation is the drawn-graphics rotation, opposite the physical
 * turn: ROTATION_90 turns the model +90 degrees, so the mesh's +u axis points
 * up on screen at rotation 1, down at 3, left at 2).
 */
const TABLE: Record<Rotation, Coeffs> = {
  0: { a: 1, b: 0, c: 0, d: 0, e: -1, f: 1 },
  1: { a: 0, b: -1, c: 1, d: -1, e: 0, f: 1 },
  2: { a: -1, b: 0, c: 1, d: 0, e: 1, f: 0 },
  3: { a: 0, b: 1, c: 0, d: 1, e: 0, f: 0 },
};

/** Maps a point on the phone's screen mesh UV to normalised stream coordinates (x right, y down, 0..1). */
export function screenUvToStream(u: number, v: number, rotation: Rotation): { x: number; y: number } {
  const t = TABLE[rotation];
  return { x: t.a * u + t.b * v + t.c, y: t.d * u + t.e * v + t.f };
}

/** The same mapping as a column-major three.js Matrix3, multiplying (u, v, 1). */
export function streamSampleMatrix(rotation: Rotation): number[] {
  const t = TABLE[rotation];
  return [t.a, t.d, 0, t.b, t.e, 0, t.c, t.f, 1];
}
