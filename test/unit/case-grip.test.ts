import { expect, test } from "vitest";
import { caseGrip, cornerPx } from "../../src/shared/case-grip";

const OPEN = { w: 800, h: 880, pxPerMm: 5.5 };
const at = (x: number, y: number, body = OPEN) => caseGrip({ ...body, x, y });

test("the top and bottom bezels move the window between the corners", () => {
  expect(at(400, 10)).toBe("move");
  expect(at(200, 3)).toBe("move");
  expect(at(600, 875)).toBe("move");
});

test("the left and right bezels turn the phone", () => {
  expect(at(4, 440)).toBe("turn");
  expect(at(796, 300)).toBe("turn");
});

test("each corner turns the phone, even on the top or bottom bezel", () => {
  const corner = cornerPx(OPEN);
  expect(corner).toBeCloseTo(55, 9);
  expect(at(corner - 1, 5)).toBe("turn");
  expect(at(800 - corner + 1, 875)).toBe("turn");
  expect(at(corner + 1, 5)).toBe("move");
});

test("a dark face splits by the nearest edge", () => {
  expect(at(400, 200)).toBe("move");
  expect(at(150, 440)).toBe("turn");
});

test("corners keep a usable size at small scales but never take more than a quarter of the short side", () => {
  expect(cornerPx({ w: 200, h: 440, pxPerMm: 1 })).toBe(16);
  expect(cornerPx({ w: 40, h: 100, pxPerMm: 5 })).toBe(10);
});
