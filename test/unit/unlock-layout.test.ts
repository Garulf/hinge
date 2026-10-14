import { expect, test } from "vitest";
import { hitAt, hitCentre, unlockLayout } from "../../src/renderer/unlock/unlock-layout";

test("the PIN pad is twelve keys in a 3x4 grid, 1 to 9 then back, 0, OK", () => {
  const layout = unlockLayout(360, 640, "pin", false);
  expect(layout.keys.map((k) => k.id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "back", "0", "ok"]);
  expect(layout.scale).toBe(1);
});

test("every key's centre hits that key", () => {
  const layout = unlockLayout(412, 915, "pin", true);
  for (const { id } of layout.keys) {
    const c = hitCentre(layout, id)!;
    expect(hitAt(layout, c.x, c.y)).toBe(id);
  }
  const cancel = hitCentre(layout, "cancel")!;
  expect(hitAt(layout, cancel.x, cancel.y)).toBe("cancel");
  const link = hitCentre(layout, "switch")!;
  expect(hitAt(layout, link.x, link.y)).toBe("switch");
});

test("the pad keeps its proportions and is centred on a wide screen", () => {
  const layout = unlockLayout(1280, 640, "pin", false);
  expect(layout.scale).toBe(1);
  const one = hitCentre(layout, "1")!;
  const three = hitCentre(layout, "3")!;
  expect((one.x + three.x) / 2).toBeCloseTo(640);
});

test("between keys nothing is hit, and the password and pattern pads have no keys", () => {
  const layout = unlockLayout(360, 640, "pin", false);
  expect(hitAt(layout, 135, 260)).toBeNull();
  expect(unlockLayout(360, 640, "password", true).keys).toEqual([]);
  expect(unlockLayout(360, 640, "pattern", true).keys).toEqual([]);
});

test("the switch link is there only when the lock type is unknown, and never on the pattern card", () => {
  expect(unlockLayout(360, 640, "pin", false).switchLink).toBeNull();
  expect(unlockLayout(360, 640, "pin", true).switchLink).not.toBeNull();
  expect(unlockLayout(360, 640, "pattern", true).switchLink).toBeNull();
});
