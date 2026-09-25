import { expect, test } from "vitest";
import { ScreenRouting } from "../../src/renderer/scene/screen-routing";

const COVER = { screen: "cover" as const, rotated: false };
const INNER = { screen: "inner" as const, rotated: false };
const INNER_LAND = { screen: "inner" as const, rotated: true };

test("the first class routes the video to its screen with nothing to hand off", () => {
  const r = new ScreenRouting();
  expect(r.streamClass(COVER)).toEqual({ from: null, to: "cover" });
  expect(r.videoScreen).toBe("cover");
});

test("a screen change hands the video off from the screen that had it", () => {
  const r = new ScreenRouting();
  r.streamClass(COVER);
  expect(r.streamClass(INNER)).toEqual({ from: "cover", to: "inner" });
  expect(r.streamClass(INNER)).toBeNull();
  expect(r.streamClass(COVER)).toEqual({ from: "inner", to: "cover" });
});

test("a rotation-only class change keeps the shown rotation until the new class's first frame", () => {
  const r = new ScreenRouting();
  r.streamClass(INNER);
  r.firstFrame();
  expect(r.rotation(0)).toBe(0);

  expect(r.streamClass(INNER_LAND)).toBeNull();
  // The director already reports the landscape rotation, but the texture
  // still holds a portrait frame.
  expect(r.rotation(1)).toBe(0);
  expect(r.rotation(1)).toBe(0);
  r.firstFrame();
  expect(r.rotation(1)).toBe(1);
});

test("flipping back before the first frame still holds the rotation shown before either change", () => {
  const r = new ScreenRouting();
  r.streamClass(INNER);
  r.firstFrame();
  r.rotation(0);
  r.streamClass(INNER_LAND);
  r.rotation(1);
  r.streamClass(INNER);
  expect(r.rotation(0)).toBe(0);
  r.firstFrame();
  expect(r.rotation(0)).toBe(0);
});

test("a rotation change within the same class applies at once", () => {
  const r = new ScreenRouting();
  r.streamClass(INNER_LAND);
  r.firstFrame();
  expect(r.rotation(1)).toBe(1);
  expect(r.rotation(3)).toBe(3);
});

test("a screen change follows the director's rotation at once, the new screen is still dark", () => {
  const r = new ScreenRouting();
  r.streamClass(INNER);
  r.firstFrame();
  r.rotation(0);
  r.streamClass({ screen: "cover", rotated: true });
  expect(r.rotation(1)).toBe(1);
});
