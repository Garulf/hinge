import { expect, test } from "vitest";
import { WindowSizer, type Size } from "../../src/shared/window-sizer";
import type { Rotation } from "../../src/shared/screen-uv";

const CLOSED = { w: 72, h: 158 };
const OPEN = { w: 144, h: 158 };

function sizer(opts: { nudgeLostResizes?: boolean } = { nudgeLostResizes: true }) {
  const requests: [Size, Rotation][] = [];
  return { requests, sizer: new WindowSizer((size, rotation) => requests.push([size, rotation]), opts) };
}

test("the first update requests the target", () => {
  const { requests, sizer: s } = sizer();
  s.update(CLOSED, 0, true);
  expect(requests).toEqual([[CLOSED, 0]]);
  s.update(CLOSED, 0, true);
  expect(requests).toHaveLength(1);
});

test("opening grows to the union at once and needs nothing more once settled", () => {
  const { requests, sizer: s } = sizer();
  s.update(CLOSED, 0, true);
  s.update(OPEN, 0, false);
  expect(requests.at(-1)).toEqual([OPEN, 0]);
  s.update(OPEN, 0, true);
  expect(requests).toHaveLength(2);
});

test("closing keeps the union while animating and shrinks to the target when settled", () => {
  const { requests, sizer: s } = sizer();
  s.update(OPEN, 0, true);
  s.update(CLOSED, 0, false);
  s.update(CLOSED, 0, false);
  expect(requests).toEqual([[OPEN, 0]]);
  s.update(CLOSED, 0, true);
  expect(requests).toEqual([[OPEN, 0], [CLOSED, 0]]);
});

test("a fold reversed before settling keeps the union until the final pose settles", () => {
  const { requests, sizer: s } = sizer();
  s.update(CLOSED, 0, true);
  s.update(OPEN, 0, false);
  s.update(CLOSED, 0, false);
  expect(requests).toEqual([[CLOSED, 0], [OPEN, 0]]);
  s.update(CLOSED, 0, true);
  expect(requests.at(-1)).toEqual([CLOSED, 0]);
});

test("a rotation change requests the rotated target directly", () => {
  const { requests, sizer: s } = sizer();
  s.update(OPEN, 0, true);
  s.update({ w: 158, h: 144 }, 1, false);
  expect(requests.at(-1)).toEqual([{ w: 158, h: 144 }, 1]);
});

test("a resize that never lands is nudged through again, a bounded number of times", () => {
  const { requests, sizer: s } = sizer();
  s.update(CLOSED, 0, true);
  s.update(OPEN, 0, true);
  s.verify(CLOSED, 0);
  s.verify(CLOSED, 399);
  expect(requests).toHaveLength(2);
  s.verify(CLOSED, 500);
  expect(requests.slice(2)).toEqual([[{ w: OPEN.w + 1, h: OPEN.h }, 0], [OPEN, 0]]);
  s.verify(CLOSED, 1000);
  s.verify(CLOSED, 1500);
  s.verify(CLOSED, 2000);
  s.verify(CLOSED, 9000);
  expect(requests).toHaveLength(8);
});

test("a window that reached its requested size is left alone", () => {
  const { requests, sizer: s } = sizer();
  s.update(OPEN, 0, true);
  s.verify(OPEN, 0);
  s.verify(OPEN, 5000);
  expect(requests).toHaveLength(1);
});

test("a new request restarts the wait before nudging", () => {
  const { requests, sizer: s } = sizer();
  s.update(CLOSED, 0, true);
  s.verify({ w: 1, h: 1 }, 0);
  s.update(OPEN, 0, true);
  s.verify(CLOSED, 1500);
  expect(requests).toHaveLength(2);
  s.verify(CLOSED, 2000);
  expect(requests).toHaveLength(4);
});

test("a sideways window is nudged along its height, the axis anchored to the fixed edge", () => {
  const { requests, sizer: s } = sizer();
  const LANDSCAPE = { w: 158, h: 144 };
  s.update(LANDSCAPE, 1, true);
  s.verify(OPEN, 0);
  s.verify(OPEN, 500);
  expect(requests.slice(1)).toEqual([[{ w: 158, h: 145 }, 1], [LANDSCAPE, 1]]);
});

test("a page within 1 px of the requested size counts as landed", () => {
  const { requests, sizer: s } = sizer();
  s.update(OPEN, 0, true);
  s.verify({ w: OPEN.w - 1, h: OPEN.h + 1 }, 0);
  s.verify({ w: OPEN.w - 1, h: OPEN.h + 1 }, 5000);
  expect(requests).toHaveLength(1);
});

test("without lost-resize nudging a mismatch is left alone", () => {
  const { requests, sizer: s } = sizer({ nudgeLostResizes: false });
  s.update(OPEN, 0, true);
  s.verify(CLOSED, 0);
  s.verify(CLOSED, 5000);
  expect(requests).toHaveLength(1);
});

test("follow requests each new size directly, growing or shrinking, and never repeats one", () => {
  const { requests, sizer: s } = sizer();
  s.update(CLOSED, 0, true);
  s.follow({ w: 100, h: 158 }, 0);
  s.follow({ w: 100, h: 158 }, 0);
  s.follow({ w: 90, h: 158 }, 0);
  expect(requests).toEqual([[CLOSED, 0], [{ w: 100, h: 158 }, 0], [{ w: 90, h: 158 }, 0]]);
});

test("after following, a fold update shrinks to its target once settled", () => {
  const { requests, sizer: s } = sizer();
  s.update(OPEN, 0, true);
  s.follow({ w: 200, h: 158 }, 0);
  s.follow({ w: 150, h: 158 }, 0);
  s.update(CLOSED, 0, false);
  expect(requests.at(-1)).toEqual([{ w: 150, h: 158 }, 0]);
  s.update(CLOSED, 0, true);
  expect(requests.at(-1)).toEqual([CLOSED, 0]);
});
