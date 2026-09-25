import { expect, test } from "vitest";
import { ModifierTracker } from "../../src/shared/modifiers";

test("a modifier is not held until its keydown arrives", () => {
  const t = new ModifierTracker();
  expect(t.held("lalt")).toBe(false);
});

test("left and right Alt, Super and Ctrl are tracked separately by KeyboardEvent.code", () => {
  const t = new ModifierTracker();
  t.handle({ type: "keydown", code: "AltLeft" });
  t.handle({ type: "keydown", code: "MetaRight" });
  t.handle({ type: "keydown", code: "ControlLeft" });

  expect(t.held("lalt")).toBe(true);
  expect(t.held("ralt")).toBe(false);
  expect(t.held("rsuper")).toBe(true);
  expect(t.held("lsuper")).toBe(false);
  expect(t.held("lctrl")).toBe(true);
  expect(t.held("rctrl")).toBe(false);
});

test("keyup of a held modifier releases it", () => {
  const t = new ModifierTracker();
  t.handle({ type: "keydown", code: "AltLeft" });
  t.handle({ type: "keyup", code: "AltLeft" });
  expect(t.held("lalt")).toBe(false);
});

test("non modifier codes are ignored", () => {
  const t = new ModifierTracker();
  t.handle({ type: "keydown", code: "KeyD" });
  expect(t.held("lalt")).toBe(false);
  expect(t.held("ralt")).toBe(false);
  expect(t.held("lsuper")).toBe(false);
  expect(t.held("rsuper")).toBe(false);
  expect(t.held("lctrl")).toBe(false);
  expect(t.held("rctrl")).toBe(false);
});

test("clear releases every held modifier, e.g. on window blur", () => {
  const t = new ModifierTracker();
  t.handle({ type: "keydown", code: "AltLeft" });
  t.handle({ type: "keydown", code: "MetaLeft" });
  t.clear();
  expect(t.held("lalt")).toBe(false);
  expect(t.held("lsuper")).toBe(false);
});
