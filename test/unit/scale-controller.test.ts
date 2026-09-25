import { expect, test } from "vitest";
import { FOLD7_BODY, showcaseSizePx } from "../../src/shared/layout";
import { ScaleController } from "../../src/renderer/scale-controller";

function setup() {
  const applied: number[] = [];
  const persisted: number[] = [];
  const scale = new ScaleController({ apply: (v) => applied.push(v), persist: (v) => persisted.push(v) });
  return { scale, applied, persisted };
}

const WORK_AREA = { w: 1600, h: 1000 };
const BASE = (0.85 * WORK_AREA.h) / FOLD7_BODY.heightMm;

test("starts at the default once the work area is known", () => {
  const { scale, applied } = setup();
  expect(scale.pxPerMm).toBeNull();
  expect(scale.step(1)).toBe(false);
  scale.setWorkArea(WORK_AREA);
  expect(applied).toEqual([BASE]);
  expect(scale.percent()).toBe(100);
});

test("a saved per-phone scale wins over the default, whichever arrives first", () => {
  const early = setup();
  early.scale.useDevice("A", 4);
  early.scale.setWorkArea(WORK_AREA);
  expect(early.applied).toEqual([4]);

  const late = setup();
  late.scale.setWorkArea(WORK_AREA);
  late.scale.useDevice("A", 4);
  expect(late.applied).toEqual([BASE, 4]);
  expect(late.persisted).toEqual([]);
});

test("a phone with no saved scale gets the default, not the previous phone's scale", () => {
  const { scale, applied } = setup();
  scale.setWorkArea(WORK_AREA);
  scale.useDevice("A", 4);
  scale.useDevice("B", undefined);
  expect(applied).toEqual([BASE, 4, BASE]);
});

test("the same phone streaming again keeps the scale on screen, so quick steps never jump back", () => {
  const { scale, applied } = setup();
  scale.setWorkArea(WORK_AREA);
  scale.useDevice("A", undefined);
  scale.step(-1);
  scale.step(-1);
  scale.useDevice("A", BASE * 0.9);
  expect(applied.at(-1)).toBeCloseTo(BASE * 0.8);
  expect(scale.percent()).toBe(80);
});

test("stepping moves 10 percent at a time, persists, and stops where the phone fills the work area", () => {
  const { scale, applied, persisted } = setup();
  scale.setWorkArea(WORK_AREA);
  scale.step(-1);
  expect(scale.percent()).toBe(90);
  scale.step(1);
  scale.step(1);
  scale.step(1);
  scale.step(1);
  expect(applied.at(-1)).toBeCloseTo(WORK_AREA.h / FOLD7_BODY.heightMm);
  expect(persisted).toHaveLength(5);
});

test("1:1 sets the scale from the video and the lit screen's size", () => {
  const { scale, applied, persisted } = setup();
  scale.setWorkArea(WORK_AREA);
  expect(scale.pixelPerfect(null, { w: 65, h: 151.7 }, 1)).toBe(false);
  expect(scale.pixelPerfect({ w: 1080, h: 2520 }, { w: 65, h: 151.7 }, 2)).toBe(true);
  expect(applied.at(-1)).toBeCloseTo(2520 / 2 / 151.7);
  expect(persisted.at(-1)).toBeCloseTo(2520 / 2 / 151.7);
});

test("fullscreen fits the phone to the screen, blocks scaling, and restores the windowed size after", () => {
  const { scale, applied, persisted } = setup();
  scale.setWorkArea(WORK_AREA);
  scale.fitFullscreen(0, { w: 1920, h: 1080 });
  expect(scale.fullscreen).toBe(true);
  expect(applied.at(-1)! * FOLD7_BODY.heightMm).toBeLessThanOrEqual(1080);
  expect(scale.step(1)).toBe(false);
  expect(scale.pixelPerfect({ w: 1080, h: 2520 }, { w: 65, h: 151.7 }, 1)).toBe(false);
  scale.useDevice("A", 3);
  const before = applied.length;
  scale.fitFullscreen(0, { w: 1920, h: 1080 });
  expect(applied.length).toBe(before);
  scale.leaveFullscreen();
  expect(scale.fullscreen).toBe(false);
  expect(applied.at(-1)).toBe(3);
  expect(persisted).toEqual([]);
});

test("the showcase size follows the current scale and is fitted to the work area", () => {
  const { scale } = setup();
  expect(scale.showcaseSize(0, 1)).toBeNull();
  scale.setWorkArea(WORK_AREA);
  expect(scale.showcaseSize(1, 2)).toEqual(showcaseSizePx(FOLD7_BODY, 1, BASE, WORK_AREA, 2));
  const narrow = setup();
  narrow.scale.setWorkArea({ w: 300, h: 1000 });
  expect(narrow.scale.showcaseSize(0, 1)!.w).toBeLessThanOrEqual(300);
});

test("the same work area again changes nothing; a different one rebases the default", () => {
  const { scale, applied } = setup();
  scale.setWorkArea(WORK_AREA);
  scale.setWorkArea({ ...WORK_AREA });
  expect(applied).toEqual([BASE]);
  scale.setWorkArea({ w: 1600, h: 2000 });
  expect(applied).toEqual([BASE, BASE]);
  expect(scale.percent()).toBe(50);
});
