import { expect, test } from "vitest";
import { insideScreenMask, screenUvToStream, streamSampleMatrix, type Rotation } from "../../src/shared/screen-uv";

const ROTATIONS: Rotation[] = [0, 1, 2, 3];

const CORNERS: Array<{ u: number; v: number }> = [
  { u: 0, v: 0 },
  { u: 1, v: 0 },
  { u: 0, v: 1 },
  { u: 1, v: 1 },
];

function expected(rotation: Rotation, u: number, v: number): { x: number; y: number } {
  switch (rotation) {
    case 0:
      return { x: u, y: 1 - v };
    case 1:
      return { x: 1 - v, y: 1 - u };
    case 2:
      return { x: 1 - u, y: v };
    case 3:
      return { x: v, y: u };
  }
}

test.each(ROTATIONS)("rotation %i maps the four corners per the table", (rotation) => {
  for (const { u, v } of CORNERS) {
    const result = screenUvToStream(u, v, rotation);
    const want = expected(rotation, u, v);
    expect(result.x).toBeCloseTo(want.x, 10);
    expect(result.y).toBeCloseTo(want.y, 10);
  }
});

test("rotation 1: the mesh's local bottom-left corner ends up at the stream's bottom-right", () => {
  const result = screenUvToStream(0, 0, 1);
  expect(result.x).toBeCloseTo(1, 10);
  expect(result.y).toBeCloseTo(1, 10);
});

function applyMatrix(m: number[], u: number, v: number): { s: number; t: number } {
  // column-major 3x3: m[0..2] col0, m[3..5] col1, m[6..8] col2
  const s = m[0] * u + m[3] * v + m[6];
  const t = m[1] * u + m[4] * v + m[7];
  return { s, t };
}

const EXPECTED_MATRIX: Record<Rotation, number[]> = {
  0: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  1: [0, 1, 0, -1, 0, 0, 1, 0, 1],
  2: [-1, 0, 0, 0, -1, 0, 1, 1, 1],
  3: [0, -1, 0, 1, 0, 0, 0, 1, 1],
};

test.each(ROTATIONS)("rotation %i: streamSampleMatrix matches the expected column-major matrix", (rotation) => {
  expect(streamSampleMatrix(rotation)).toEqual(EXPECTED_MATRIX[rotation]);
});

test.each(ROTATIONS)("rotation %i: the matrix (s right, t up) and the function (x right, y down) agree on a 5x5 grid", (rotation) => {
  const m = streamSampleMatrix(rotation);
  expect(m).toHaveLength(9);
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const u = i / 4;
      const v = j / 4;
      const fromFn = screenUvToStream(u, v, rotation);
      const fromMatrix = applyMatrix(m, u, v);
      expect(fromMatrix.s).toBeCloseTo(fromFn.x, 10);
      expect(fromMatrix.t).toBeCloseTo(1 - fromFn.y, 10);
    }
  }
});

test("insideScreenMask cuts the rounded corners, measured in screen pixels", () => {
  const radius: [number, number] = [0.1, 0.05];
  const pixels: [number, number] = [100, 200];
  expect(insideScreenMask(0.5, 0.5, radius, pixels)).toBe(true);
  expect(insideScreenMask(0.5, 0.001, radius, pixels)).toBe(true);
  expect(insideScreenMask(0.001, 0.5, radius, pixels)).toBe(true);
  expect(insideScreenMask(0.01, 0.005, radius, pixels)).toBe(false);
  expect(insideScreenMask(0.99, 0.995, radius, pixels)).toBe(false);
  // 10 px radius: a point 2 px in from both edges is outside, 4 px in along the diagonal of a 10 px arc is inside.
  expect(insideScreenMask(0.02, 0.01, radius, pixels)).toBe(false);
  expect(insideScreenMask(0.04, 0.02, radius, pixels)).toBe(true);
  expect(insideScreenMask(1.01, 0.5, radius, pixels)).toBe(false);
});
