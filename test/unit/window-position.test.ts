import { expect, test } from "vitest";
import { cornerOf, DevicePlacement, restoredBounds, type Corner } from "../../src/main/window-position";
import type { Rect } from "../../src/shared/clamp-bounds";

const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const SECOND: Rect = { x: 1920, y: 0, width: 2560, height: 1400 };
const workAreaFor = (r: Rect) => (r.x + r.width / 2 >= 1920 ? SECOND : PRIMARY);

test("the saved position is the top-right corner", () => {
  expect(cornerOf({ x: 100, y: 50, width: 400, height: 880 })).toEqual({ x: 500, y: 50 });
});

test("restoring puts the right edge back on the saved corner whatever the current width", () => {
  expect(restoredBounds({ x: 0, y: 0, width: 800, height: 880 }, { x: 1500, y: 60 }, workAreaFor)).toEqual({ x: 700, y: 60, width: 800, height: 880 });
});

test("a saved corner off the display (monitor gone, or resolution changed) is clamped into a work area", () => {
  expect(restoredBounds({ x: 0, y: 0, width: 400, height: 880 }, { x: 5000, y: 900 }, workAreaFor)).toEqual({ x: 4080, y: 520, width: 400, height: 880 });
  expect(restoredBounds({ x: 0, y: 0, width: 400, height: 880 }, { x: 100, y: -300 }, workAreaFor)).toEqual({ x: 0, y: 0, width: 400, height: 880 });
});

function setup(saved: Record<string, Corner> = {}) {
  let bounds: Rect = { x: 10, y: 20, width: 400, height: 880 };
  const moves: Rect[] = [];
  const saves: [string, Corner][] = [];
  const timers: (() => void)[] = [];
  const placement = new DevicePlacement({
    getContentBounds: () => bounds,
    setContentBounds: (b) => {
      bounds = b;
      moves.push(b);
    },
    workAreaFor,
    saved: (serial) => saved[serial],
    save: (serial, corner) => saves.push([serial, corner]),
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => timers.splice(0, timers.length),
  });
  return { placement, moves, saves, timers, move: (b: Rect) => (bounds = b) };
}

test("a phone with a saved corner moves the window there when it streams, once per phone", () => {
  const { placement, moves } = setup({ A: { x: 1000, y: 100 } });
  placement.status({ state: "connecting", serial: "A" });
  expect(moves).toEqual([]);
  placement.status({ state: "streaming", serial: "A", model: null });
  placement.status({ state: "streaming", serial: "A", model: null });
  expect(moves).toEqual([{ x: 600, y: 100, width: 400, height: 880 }]);
  placement.status({ state: "streaming", serial: "B", model: null });
  expect(moves).toHaveLength(1);
});

test("moving the window saves its corner for the phone on screen, after it settles", () => {
  const { placement, saves, timers, move } = setup();
  placement.moved();
  expect(timers).toHaveLength(0);
  placement.status({ state: "streaming", serial: "A", model: null });
  move({ x: 300, y: 40, width: 400, height: 880 });
  placement.moved();
  placement.moved();
  expect(timers).toHaveLength(1);
  timers[0]();
  expect(saves).toEqual([["A", { x: 700, y: 40 }]]);
});

test("a save still pending when another phone starts streaming is dropped, not written to the new phone", () => {
  const { placement, saves, timers } = setup();
  placement.status({ state: "streaming", serial: "A", model: null });
  placement.moved();
  placement.status({ state: "streaming", serial: "B", model: null });
  expect(timers).toHaveLength(0);
  expect(saves).toEqual([]);
});
