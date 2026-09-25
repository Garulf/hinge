import { expect, test } from "vitest";
import { screenUvToStream, streamSampleMatrix, type Rotation } from "../../src/shared/screen-uv";

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

function applyMatrix(m: number[], u: number, v: number): { x: number; y: number } {
  // column-major 3x3: m[0..2] col0, m[3..5] col1, m[6..8] col2
  const x = m[0] * u + m[3] * v + m[6];
  const y = m[1] * u + m[4] * v + m[7];
  return { x, y };
}

test.each(ROTATIONS)("rotation %i: the matrix and function agree on a 5x5 grid", (rotation) => {
  const m = streamSampleMatrix(rotation);
  expect(m).toHaveLength(9);
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const u = i / 4;
      const v = j / 4;
      const fromFn = screenUvToStream(u, v, rotation);
      const fromMatrix = applyMatrix(m, u, v);
      expect(fromMatrix.x).toBeCloseTo(fromFn.x, 10);
      expect(fromMatrix.y).toBeCloseTo(fromFn.y, 10);
    }
  }
});
