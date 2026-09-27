import { expect, test } from "vitest";
import { ModifierTracker } from "../../src/shared/modifiers";
import type { KeyEventLike } from "../../src/shared/keymap";
import { defaultModifiers, normaliseModifiers, ShortcutHandler, SHORTCUT_TABLE } from "../../src/shared/shortcuts";

const HOME = 3;
const BACK = 4;
const APP_SWITCH = 187;
const MENU = 82;
const VOLUME_UP = 24;
const VOLUME_DOWN = 25;
const POWER = 26;
const COPY = 278;
const CUT = 277;

function key(type: "keydown" | "keyup", code: string, over: Partial<KeyEventLike> = {}): KeyEventLike {
  return { type, code, key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...over };
}

function handler(accepted?: string[]) {
  const modifiers = new ModifierTracker();
  const h = new ShortcutHandler(modifiers, () => normaliseModifiers(accepted));
  const feed = (e: KeyEventLike, paused = false) => {
    modifiers.handle(e);
    return h.handle(e, paused);
  };
  return { h, feed, modifiers };
}

function press(feed: ReturnType<typeof handler>["feed"], code: string, over: Partial<KeyEventLike> = {}, paused = false) {
  return [feed(key("keydown", code, over), paused), feed(key("keyup", code, over), paused)];
}

test("device keys follow the press: MOD+h sends HOME down on press and up on release", () => {
  const { feed } = handler();
  feed(key("keydown", "AltLeft", { altKey: true }));
  const [down, up] = press(feed, "KeyH", { altKey: true });
  expect(down).toEqual({ intents: [{ type: "key", action: "down", keyCode: HOME, repeat: 0, metaState: 0 }], action: null, claimed: true });
  expect(up).toEqual({ intents: [{ type: "key", action: "up", keyCode: HOME, repeat: 0, metaState: 0 }], action: null, claimed: true });
});

test("the whole scrcpy key table maps to the right Android keycodes", () => {
  const cases: [string, number][] = [
    ["KeyB", BACK],
    ["Backspace", BACK],
    ["KeyS", APP_SWITCH],
    ["KeyM", MENU],
    ["ArrowUp", VOLUME_UP],
    ["ArrowDown", VOLUME_DOWN],
    ["KeyP", POWER],
    ["KeyC", COPY],
    ["KeyX", CUT],
  ];
  for (const [code, keyCode] of cases) {
    const { feed } = handler();
    feed(key("keydown", "MetaLeft", { metaKey: true }));
    const [down] = press(feed, code, { metaKey: true });
    expect(down?.intents, code).toEqual([{ type: "key", action: "down", keyCode, repeat: 0, metaState: 0 }]);
  }
});

test("control intents fire once on press", () => {
  const cases: [string, boolean, unknown][] = [
    ["KeyO", false, { type: "display-power", on: false }],
    ["KeyO", true, { type: "display-power", on: true }],
    ["KeyR", false, { type: "rotate-device" }],
    ["KeyR", true, { type: "reset-video" }],
    ["KeyN", true, { type: "collapse-panels" }],
    ["KeyV", false, { type: "clipboard-paste", asText: false }],
    ["KeyV", true, { type: "clipboard-paste", asText: true }],
  ];
  for (const [code, shiftKey, intent] of cases) {
    const { feed } = handler();
    feed(key("keydown", "AltLeft", { altKey: true }));
    if (shiftKey) feed(key("keydown", "ShiftLeft", { altKey: true, shiftKey }));
    const [down, up] = press(feed, code, { altKey: true, shiftKey });
    expect(down?.intents, `${code} shift=${shiftKey}`).toEqual([intent]);
    expect(up?.intents).toEqual([]);
  }
});

test("hinge actions: f g w q i z Shift+z d, and F11 without MOD", () => {
  const cases: [string, boolean, string][] = [
    ["KeyF", false, "fullscreen"],
    ["KeyG", false, "pixel-perfect"],
    ["KeyW", false, "fit"],
    ["KeyQ", false, "quit"],
    ["KeyI", false, "toggle-fps"],
    ["KeyZ", false, "pause"],
    ["KeyZ", true, "unpause"],
    ["KeyD", false, "center"],
  ];
  for (const [code, shiftKey, action] of cases) {
    const { feed } = handler();
    feed(key("keydown", "AltLeft", { altKey: true }));
    const [down] = press(feed, code, { altKey: true, shiftKey });
    expect(down, code).toEqual({ intents: [], action, claimed: true });
  }
  const { feed } = handler();
  expect(feed(key("keydown", "F11"))).toEqual({ intents: [], action: "fullscreen", claimed: true });
  expect(feed(key("keydown", "F11", { ctrlKey: true }))).toBeNull();
});

test("MOD+n expands notifications, a second n while MOD is still held expands settings", () => {
  const { feed } = handler();
  feed(key("keydown", "AltLeft", { altKey: true }));
  expect(press(feed, "KeyN", { altKey: true })[0]?.intents).toEqual([{ type: "expand-notifications" }]);
  expect(press(feed, "KeyN", { altKey: true })[0]?.intents).toEqual([{ type: "expand-settings" }]);
  feed(key("keyup", "AltLeft"));
  feed(key("keydown", "AltLeft", { altKey: true }));
  expect(press(feed, "KeyN", { altKey: true })[0]?.intents).toEqual([{ type: "expand-notifications" }]);
});

test("volume keys forward auto-repeat, other keys ignore it", () => {
  const { feed } = handler();
  feed(key("keydown", "AltLeft", { altKey: true }));
  feed(key("keydown", "ArrowUp", { altKey: true }));
  expect(feed(key("keydown", "ArrowUp", { altKey: true, repeat: true }))?.intents).toEqual([{ type: "key", action: "down", keyCode: VOLUME_UP, repeat: 1, metaState: 0 }]);
  feed(key("keydown", "KeyH", { altKey: true }));
  expect(feed(key("keydown", "KeyH", { altKey: true, repeat: true }))).toEqual({ intents: [], action: null, claimed: true });
});

test("the key up is sent even if MOD was released first", () => {
  const { feed } = handler();
  feed(key("keydown", "AltLeft", { altKey: true }));
  feed(key("keydown", "KeyB", { altKey: true }));
  feed(key("keyup", "AltLeft"));
  expect(feed(key("keyup", "KeyB"))?.intents).toEqual([{ type: "key", action: "up", keyCode: BACK, repeat: 0, metaState: 0 }]);
});

test("flush releases device keys still held", () => {
  const { h, feed } = handler();
  feed(key("keydown", "AltLeft", { altKey: true }));
  feed(key("keydown", "ArrowDown", { altKey: true }));
  expect(h.flush()).toEqual([{ type: "key", action: "up", keyCode: VOLUME_DOWN, repeat: 0, metaState: 0 }]);
  expect(h.flush()).toEqual([]);
});

test("without MOD nothing is a shortcut", () => {
  const { feed } = handler();
  expect(feed(key("keydown", "KeyH"))).toBeNull();
  expect(feed(key("keydown", "KeyH", { altKey: true }))).toBeNull();
});

test("an unmapped MOD combo is swallowed but left unclaimed, so the OS still sees Alt+F4", () => {
  const { feed } = handler();
  feed(key("keydown", "AltLeft", { altKey: true }));
  expect(feed(key("keydown", "F4", { altKey: true }))).toEqual({ intents: [], action: null, claimed: false });
  expect(feed(key("keydown", "KeyH", { altKey: true, shiftKey: true }))).toEqual({ intents: [], action: null, claimed: false });
});

test("a shortcut the filter refuses is swallowed like an unmapped combo and leaves no key held", () => {
  const modifiers = new ModifierTracker();
  const h = new ShortcutHandler(modifiers, () => normaliseModifiers(undefined), (code) => code === "KeyB");
  const feed = (e: KeyEventLike) => {
    modifiers.handle(e);
    return h.handle(e, false);
  };
  feed(key("keydown", "AltLeft", { altKey: true }));
  expect(feed(key("keydown", "KeyH", { altKey: true }))).toEqual({ intents: [], action: null, claimed: false });
  expect(feed(key("keydown", "KeyQ", { altKey: true }))).toEqual({ intents: [], action: null, claimed: false });
  expect(h.flush()).toEqual([]);
  expect(feed(key("keydown", "KeyB", { altKey: true }))?.intents).toEqual([{ type: "key", action: "down", keyCode: BACK, repeat: 0, metaState: 0 }]);
});

test("while paused, device shortcuts do nothing but unpause and the window actions still work", () => {
  const { feed } = handler();
  feed(key("keydown", "AltLeft", { altKey: true }), true);
  expect(feed(key("keydown", "KeyH", { altKey: true }), true)).toEqual({ intents: [], action: null, claimed: true });
  expect(feed(key("keydown", "KeyR", { altKey: true }), true)).toEqual({ intents: [], action: null, claimed: true });
  expect(feed(key("keydown", "KeyZ", { altKey: true, shiftKey: true }), true)?.action).toBe("unpause");
  expect(feed(key("keydown", "KeyF", { altKey: true }), true)?.action).toBe("fullscreen");
});

test("AltGr (Ctrl+Alt) with a printable key is text, never a shortcut, even when Ctrl is the MOD", () => {
  const { feed } = handler(["lctrl"]);
  feed(key("keydown", "ControlLeft", { ctrlKey: true }));
  feed(key("keydown", "AltRight", { ctrlKey: true, altKey: true }));
  expect(feed(key("keydown", "KeyQ", { ctrlKey: true, altKey: true, key: "@" }))).toBeNull();
  expect(feed(key("keydown", "KeyE", { ctrlKey: true, altKey: true, key: "€" }))).toBeNull();
});

test("the configured modifier replaces the default one", () => {
  const { feed } = handler(["rctrl"]);
  feed(key("keydown", "AltLeft", { altKey: true }));
  expect(feed(key("keydown", "KeyH", { altKey: true }))).toBeNull();
  feed(key("keyup", "AltLeft"));
  feed(key("keydown", "ControlRight", { ctrlKey: true }));
  expect(feed(key("keydown", "KeyH", { ctrlKey: true }))?.intents).toHaveLength(1);
});

test("modHeld reports whether a configured modifier is down, for MOD+wheel", () => {
  const { h, feed } = handler();
  expect(h.modHeld()).toBe(false);
  feed(key("keydown", "MetaLeft", { metaKey: true }));
  expect(h.modHeld()).toBe(true);
});

test("normaliseModifiers keeps known names in order, drops the rest, and falls back to lalt + lsuper", () => {
  expect(normaliseModifiers(undefined)).toEqual(["lalt", "lsuper"]);
  expect(normaliseModifiers([])).toEqual(["lalt", "lsuper"]);
  expect(normaliseModifiers(["bogus"])).toEqual(["lalt", "lsuper"]);
  expect(normaliseModifiers(["rsuper", "bogus", "rsuper", "lctrl"])).toEqual(["rsuper", "lctrl"]);
  expect(normaliseModifiers("ralt")).toEqual(["ralt"]);
});

test("MOD defaults to left Alt alone on Windows, which reserves most Win+letter combos, and left Alt + left Super elsewhere", () => {
  expect(defaultModifiers("win32")).toEqual(["lalt"]);
  expect(defaultModifiers("linux")).toEqual(["lalt", "lsuper"]);
  expect(defaultModifiers("darwin")).toEqual(["lalt", "lsuper"]);
  expect(normaliseModifiers(undefined, defaultModifiers("win32"))).toEqual(["lalt"]);
  expect(normaliseModifiers(["bogus"], defaultModifiers("win32"))).toEqual(["lalt"]);
});

test("the table covers every letter scrcpy documents plus hinge's d", () => {
  expect(Object.keys(SHORTCUT_TABLE).sort()).toEqual(
    ["ArrowDown", "ArrowUp", "Backspace", "KeyB", "KeyC", "KeyD", "KeyF", "KeyG", "KeyH", "KeyI", "KeyM", "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyV", "KeyW", "KeyX", "KeyZ"].sort(),
  );
});

test("right Alt (AltGr on many layouts) and right Super are not MOD by default", () => {
  for (const code of ["AltRight", "MetaRight"]) {
    const { feed } = handler();
    feed(key("keydown", code, { altKey: code === "AltRight", metaKey: code === "MetaRight" }));
    expect(feed(key("keydown", "KeyD", { altKey: code === "AltRight", metaKey: code === "MetaRight" })), code).toBeNull();
  }
});
