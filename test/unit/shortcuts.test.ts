import { expect, test } from "vitest";
import { hingeShortcut, type HingeAction } from "../../src/shared/shortcuts";

type Ev = Parameters<typeof hingeShortcut>[0];

const ev = (over: Partial<Ev>): Ev => ({
  code: "KeyD",
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  type: "keydown",
  repeat: false,
  ...over,
});

test("KeyD keydown with alt gives toggle-view", () => {
  const action: HingeAction | null = hingeShortcut(ev({ altKey: true }));
  expect(action).toBe("toggle-view");
});

test("KeyD keydown with meta gives toggle-view", () => {
  expect(hingeShortcut(ev({ metaKey: true }))).toBe("toggle-view");
});

test("KeyD keydown with neither alt nor meta gives null", () => {
  expect(hingeShortcut(ev({}))).toBeNull();
});

test("KeyD keydown with ctrl held gives null even with alt", () => {
  expect(hingeShortcut(ev({ altKey: true, ctrlKey: true }))).toBeNull();
});

test("a repeat KeyD keydown gives null", () => {
  expect(hingeShortcut(ev({ altKey: true, repeat: true }))).toBeNull();
});

test("KeyD keyup gives null", () => {
  expect(hingeShortcut(ev({ altKey: true, type: "keyup" }))).toBeNull();
});

test("a different key with alt gives null", () => {
  expect(hingeShortcut(ev({ altKey: true, code: "KeyE" }))).toBeNull();
});
