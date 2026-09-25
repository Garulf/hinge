import { expect, test } from "vitest";
import { KeyTracker, keyIntents, type KeyEventLike } from "../../src/shared/keymap";

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

test("KeyTracker sends a matching up for a ctrl+letter down, unlike bare keyIntents (I4)", () => {
  const t = new KeyTracker();
  const down = t.handle(ev({ ctrlKey: true, key: "c", code: "KeyC" }));
  expect(down).toEqual([{ type: "key", action: "down", keyCode: 31, repeat: 0, metaState: 4096 | 8192 }]);

  // Ctrl is still held when the letter is released, same as bare keyIntents.
  const up = t.handle(ev({ type: "keyup", ctrlKey: true, key: "c", code: "KeyC" }));
  expect(up).toEqual([{ type: "key", action: "up", keyCode: 31, repeat: 0, metaState: 4096 | 8192 }]);
});

test("KeyTracker still sends the up when ctrl is released before the letter", () => {
  const t = new KeyTracker();
  t.handle(ev({ ctrlKey: true, key: "c", code: "KeyC" }));

  // Ctrl released first: the keyup event for "c" now reports ctrlKey false
  // and a bare, unmodified key, exactly as a browser would report it.
  const up = t.handle(ev({ type: "keyup", ctrlKey: false, key: "c", code: "KeyC" }));
  expect(up).toEqual([{ type: "key", action: "up", keyCode: 31, repeat: 0, metaState: 0 }]);
});

test("KeyTracker does not send an up for a key that was sent as text", () => {
  const t = new KeyTracker();
  t.handle(ev({ key: "a", code: "KeyA" }));
  expect(t.handle(ev({ type: "keyup", key: "a", code: "KeyA" }))).toEqual([]);
});

test("KeyTracker.flush sends an up for every key still held, then forgets them", () => {
  const t = new KeyTracker();
  t.handle(ev({ ctrlKey: true, key: "c", code: "KeyC" }));
  t.handle(ev({ code: "ArrowLeft", key: "ArrowLeft" }));

  const flushed = t.flush();
  expect(flushed).toHaveLength(2);
  expect(flushed.map((i) => i.type === "key" && i.keyCode).sort()).toEqual([21, 31]);
  expect(t.flush()).toEqual([]);
});

test("AltGr (Ctrl+Alt) with a printable key is text, on keydown only", () => {
  expect(keyIntents(ev({ code: "KeyQ", key: "@", ctrlKey: true, altKey: true }))).toEqual([{ type: "text", text: "@" }]);
  expect(keyIntents(ev({ type: "keyup", code: "KeyQ", key: "@", ctrlKey: true, altKey: true }))).toEqual([]);
  expect(keyIntents(ev({ code: "F4", key: "F4", ctrlKey: true, altKey: true }))).toEqual([]);
});

test("Ctrl+V pastes the PC clipboard instead of sending the key", () => {
  expect(keyIntents(ev({ code: "KeyV", key: "v", ctrlKey: true }))).toEqual([{ type: "clipboard-paste", asText: false }]);
  expect(keyIntents(ev({ code: "KeyV", key: "v", ctrlKey: true, repeat: true }))).toEqual([]);
  expect(keyIntents(ev({ type: "keyup", code: "KeyV", key: "v", ctrlKey: true }))).toEqual([]);
  expect(keyIntents(ev({ code: "KeyV", key: "V", ctrlKey: true, shiftKey: true }))[0]).toMatchObject({ type: "key", keyCode: 50 });
});
