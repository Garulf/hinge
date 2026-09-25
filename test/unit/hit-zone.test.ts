import { expect, test } from "vitest";
import { bodyRectIn, inMenuZone, MENU_HIDE_DELAY_MS, MenuVisibility, panelBox, pillHeightPx, sizeForPanel, topBezelMm } from "../../src/renderer/chrome/hit-zone";
import { FOLD7_BODY } from "../../src/shared/layout";

const body = { w: 400, h: 880 };

test("the body sits against the fixed half's edge, or centred in fullscreen", () => {
  const win = { w: 600, h: 900 };
  expect(bodyRectIn(win, body, 0, false)).toEqual({ x: 200, y: 10, w: 400, h: 880 });
  expect(bodyRectIn(win, body, 2, false)).toEqual({ x: 0, y: 10, w: 400, h: 880 });
  expect(bodyRectIn({ w: 900, h: 600 }, { w: 880, h: 400 }, 1, false)).toEqual({ x: 10, y: 0, w: 880, h: 400 });
  expect(bodyRectIn({ w: 900, h: 600 }, { w: 880, h: 400 }, 3, false)).toEqual({ x: 10, y: 200, w: 880, h: 400 });
  expect(bodyRectIn({ w: 1920, h: 1080 }, body, 0, true)).toEqual({ x: 760, y: 100, w: 400, h: 880 });
});

test("the menu zone is the top 24 px over the phone only", () => {
  const rect = { x: 200, y: 10, w: 400, h: 880 };
  expect(inMenuZone({ x: 300, y: 10 }, rect)).toBe(true);
  expect(inMenuZone({ x: 300, y: 33 }, rect)).toBe(true);
  expect(inMenuZone({ x: 300, y: 34 }, rect)).toBe(false);
  expect(inMenuZone({ x: 300, y: 5 }, rect)).toBe(false);
  expect(inMenuZone({ x: 150, y: 12 }, rect)).toBe(false);
});

test("the menu lingers after the pointer leaves, and stays while a panel is open or the pointer is on it", () => {
  const rect = { x: 0, y: 0, w: 400, h: 880 };
  const v = new MenuVisibility();
  expect(v.visible(0, false)).toBe(false);
  v.pointer({ x: 100, y: 5 }, rect, false, 1000);
  expect(v.visible(1000, false)).toBe(true);
  v.pointer({ x: 100, y: 300 }, rect, false, 1100);
  expect(v.visible(1000 + MENU_HIDE_DELAY_MS - 1, false)).toBe(true);
  expect(v.visible(1000 + MENU_HIDE_DELAY_MS, false)).toBe(false);
  expect(v.visible(5000, true)).toBe(true);
  v.pointer({ x: 100, y: 60 }, rect, true, 6000);
  expect(v.visible(6000, false)).toBe(true);
  v.hide();
  expect(v.visible(6000, false)).toBe(false);
});

test("a panel is centred on the phone, kept inside the window, and says how much window it needs", () => {
  expect(panelBox({ x: 200, y: 0, w: 400, h: 880 }, { w: 600, h: 880 }, { w: 300, h: 400 }, 40)).toEqual({ x: 250, y: 40, w: 300, h: 400 });
  expect(panelBox({ x: 400, y: 0, w: 200, h: 880 }, { w: 600, h: 880 }, { w: 300, h: 400 }, 40).x).toBe(292);
  expect(panelBox({ x: 0, y: 0, w: 200, h: 880 }, { w: 600, h: 880 }, { w: 300, h: 400 }, 40).x).toBe(8);
  expect(sizeForPanel({ w: 300, h: 400 }, 40)).toEqual({ w: 316, h: 456 });
});

test("the menu zone is only the bezel band when the bezel is shallower than 24 px", () => {
  const rect = { x: 0, y: 0, w: 400, h: 880 };
  expect(inMenuZone({ x: 200, y: 17 }, rect, 18)).toBe(true);
  expect(inMenuZone({ x: 200, y: 18 }, rect, 18)).toBe(false);
  expect(inMenuZone({ x: 200, y: 23 }, rect, 40)).toBe(true);
  expect(inMenuZone({ x: 200, y: 24 }, rect, 40)).toBe(false);
});

test("the top bezel depth follows the lit screen and the rotation", () => {
  const cover = { w: 65, h: 151.7 };
  const inner = { w: 135.8, h: 150.7 };
  expect(topBezelMm(FOLD7_BODY, false, 0, cover)).toBeCloseTo((158.4 - 151.7) / 2);
  expect(topBezelMm(FOLD7_BODY, true, 0, inner)).toBeCloseTo((158.4 - 150.7) / 2);
  expect(topBezelMm(FOLD7_BODY, true, 1, inner)).toBeCloseTo((143.7 - 135.8) / 2);
  expect(topBezelMm(FOLD7_BODY, false, 3, cover)).toBeCloseTo((72.1 - 65) / 2);
  expect(topBezelMm(FOLD7_BODY, false, 0, null)).toBe(4);
});

test("the pill is the bezel's depth, within 22 to 32 px", () => {
  expect(pillHeightPx(18.7)).toBe(22);
  expect(pillHeightPx(26.4)).toBe(26);
  expect(pillHeightPx(60)).toBe(32);
});
