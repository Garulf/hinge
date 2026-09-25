import { expect, test } from "vitest";
import { keyIntents, type KeyEventLike } from "../../src/shared/keymap";

const ev = (over: Partial<KeyEventLike>): KeyEventLike => ({ type: "keydown", code: "KeyA", key: "a", repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...over });

test("printable characters without modifiers are injected as text on keydown only", () => {
  expect(keyIntents(ev({ key: "a" }))).toEqual([{ type: "text", text: "a" }]);
  expect(keyIntents(ev({ key: "é", code: "Quote" }))).toEqual([{ type: "text", text: "é" }]);
  expect(keyIntents(ev({ type: "keyup", key: "a" }))).toEqual([]);
});

test("ctrl shortcuts are sent as keycodes with meta state", () => {
  expect(keyIntents(ev({ ctrlKey: true, key: "c", code: "KeyC" }))).toEqual([{ type: "key", action: "down", keyCode: 31, repeat: 0, metaState: 4096 | 8192 }]);
});

test("non printable keys map to Android keycodes on both edges", () => {
  expect(keyIntents(ev({ code: "Enter", key: "Enter" }))[0]).toMatchObject({ type: "key", action: "down", keyCode: 66 });
  expect(keyIntents(ev({ type: "keyup", code: "Backspace", key: "Backspace" }))[0]).toMatchObject({ action: "up", keyCode: 67 });
  expect(keyIntents(ev({ code: "ArrowLeft", key: "ArrowLeft", repeat: true }))[0]).toMatchObject({ keyCode: 21, repeat: 1 });
});

test("alt and super alone produce nothing, they are the shortcut modifier", () => {
  expect(keyIntents(ev({ code: "AltLeft", key: "Alt", altKey: true }))).toEqual([]);
  expect(keyIntents(ev({ code: "MetaLeft", key: "Meta", metaKey: true }))).toEqual([]);
  expect(keyIntents(ev({ altKey: true, key: "h", code: "KeyH" }))).toEqual([]);
});

test("unknown codes produce nothing", () => expect(keyIntents(ev({ code: "F13", key: "F13" }))).toEqual([]));
