import { expect, test } from "vitest";
import { ModifierTracker } from "../../src/shared/modifiers";
import { hingeShortcut, type HingeAction } from "../../src/shared/shortcuts";

type Ev = Parameters<typeof hingeShortcut>[0];

const ev = (over: Partial<Ev>): Ev => ({
  code: "KeyD",
  type: "keydown",
  repeat: false,
  ...over,
});

function trackerHolding(...codes: string[]): ModifierTracker {
  const t = new ModifierTracker();
  for (const code of codes) t.handle({ type: "keydown", code });
  return t;
}

test("KeyD keydown with left Alt held gives toggle-view", () => {
  const action: HingeAction | null = hingeShortcut(ev({}), trackerHolding("AltLeft"));
  expect(action).toBe("toggle-view");
});

test("KeyD keydown with left Super held gives toggle-view", () => {
  expect(hingeShortcut(ev({}), trackerHolding("MetaLeft"))).toBe("toggle-view");
});

test("KeyD keydown with right Alt held gives null: right Alt is AltGr on many layouts", () => {
  expect(hingeShortcut(ev({}), trackerHolding("AltRight"))).toBeNull();
});

test("KeyD keydown with right Super held gives null by default", () => {
  expect(hingeShortcut(ev({}), trackerHolding("MetaRight"))).toBeNull();
});

test("KeyD keydown with no modifier held gives null", () => {
  expect(hingeShortcut(ev({}), trackerHolding())).toBeNull();
});

test("KeyD keydown with left Alt and either Ctrl held gives null", () => {
  expect(hingeShortcut(ev({}), trackerHolding("AltLeft", "ControlLeft"))).toBeNull();
  expect(hingeShortcut(ev({}), trackerHolding("AltLeft", "ControlRight"))).toBeNull();
});

test("a repeat KeyD keydown gives null", () => {
  expect(hingeShortcut(ev({ repeat: true }), trackerHolding("AltLeft"))).toBeNull();
});

test("KeyD keyup gives null", () => {
  expect(hingeShortcut(ev({ type: "keyup" }), trackerHolding("AltLeft"))).toBeNull();
});

test("a different key with left Alt held gives null", () => {
  expect(hingeShortcut(ev({ code: "KeyE" }), trackerHolding("AltLeft"))).toBeNull();
});

test("the accepted modifier set is overridable, e.g. right Alt only", () => {
  expect(hingeShortcut(ev({}), trackerHolding("AltRight"), ["ralt"])).toBe("toggle-view");
  expect(hingeShortcut(ev({}), trackerHolding("AltLeft"), ["ralt"])).toBeNull();
});
