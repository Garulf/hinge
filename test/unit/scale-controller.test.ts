import { expect, test } from "vitest";
import { FOLD7_BODY } from "../../src/shared/layout";
import { ScaleController } from "../../src/renderer/scale-controller";
import { nextPxPerMm } from "../../src/shared/scale";

function setup() {
  const applied: number[] = [];
  const persisted: number[] = [];
  const scale = new ScaleController({ apply: (v) => applied.push(v), persist: (v) => persisted.push(v) });
  return { scale, applied, persisted };
}

function settle(scale: ScaleController): void {
  for (let i = 0; i < 60; i++) scale.tick(16);
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
  settle(scale);
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
  settle(scale);
  expect(applied.at(-1)).toBeCloseTo(WORK_AREA.h / FOLD7_BODY.heightMm);
  expect(persisted).toHaveLength(5);
});

test("1:1 sets the scale from the video and the lit screen's size", () => {
  const { scale, applied, persisted } = setup();
  scale.setWorkArea(WORK_AREA);
  expect(scale.pixelPerfect(null, { w: 65, h: 151.7 }, 1)).toBe(false);
  expect(scale.pixelPerfect({ w: 1080, h: 2520 }, { w: 65, h: 151.7 }, 2)).toBe(true);
  settle(scale);
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

test("the same work area again changes nothing; a different one rebases the default", () => {
  const { scale, applied } = setup();
  scale.setWorkArea(WORK_AREA);
  scale.setWorkArea({ ...WORK_AREA });
  expect(applied).toEqual([BASE]);
  scale.setWorkArea({ w: 1600, h: 2000 });
  expect(applied).toEqual([BASE, BASE]);
  expect(scale.percent()).toBe(50);
});

test("a step eases in over a few frames, never overshooting, and rests exactly on the 10 percent grid", () => {
  const { scale, applied } = setup();
  scale.setWorkArea(WORK_AREA);
  scale.step(1);
  expect(scale.percent()).toBe(110);
  expect(applied).toEqual([BASE]);
  scale.tick(16);
  const first = applied.at(-1)!;
  expect(first).toBeGreaterThan(BASE);
  expect(first).toBeLessThan(BASE * 1.1);
  expect(scale.pxPerMm).toBe(first);
  settle(scale);
  expect(Math.max(...applied)).toBeLessThanOrEqual(BASE * 1.1);
  expect(applied.at(-1)).toBe(BASE * 1.1);
  const settled = applied.length;
  scale.tick(16);
  expect(applied.length).toBe(settled);
});

test("steps taken while one eases stack onto its target, not onto the size on screen", () => {
  const { scale, applied, persisted } = setup();
  scale.setWorkArea(WORK_AREA);
  scale.step(-1);
  scale.tick(16);
  scale.step(-1);
  scale.tick(16);
  scale.step(-1);
  expect(scale.percent()).toBe(70);
  expect(persisted.map((v) => v / BASE)).toEqual([0.9, 0.8, 0.7].map((v) => expect.closeTo(v)));
  settle(scale);
  expect(applied.at(-1)! / BASE).toBeCloseTo(0.7);
});

test("switching phones and entering fullscreen mid-ease jump straight to their scale", () => {
  const { scale, applied } = setup();
  scale.setWorkArea(WORK_AREA);
  scale.step(1);
  scale.tick(16);
  scale.useDevice("A", 4);
  expect(applied.at(-1)).toBe(4);
  expect(scale.pxPerMm).toBe(4);
  scale.tick(16);
  expect(applied.at(-1)).toBe(4);

  scale.step(1);
  scale.fitFullscreen(0, { w: 1920, h: 1080 });
  const fitted = applied.at(-1);
  scale.tick(16);
  expect(applied.at(-1)).toBe(fitted);
  settle(scale);
  scale.leaveFullscreen();
  expect(applied.at(-1)).toBeCloseTo(nextPxPerMm(4, BASE, 1, WORK_AREA.h / FOLD7_BODY.heightMm));
});
