import { expect, test } from "vitest";
import { mirrorPoint, streamToDevice, TouchTracker } from "../../src/shared/touch";

test("normalised stream points scale to device pixels, y down, clamped to the stream", () => {
  expect(streamToDevice(0, 0, 1080, 2520)).toEqual({ x: 0, y: 0 });
  expect(streamToDevice(0.25, 0.75, 1080, 2520)).toEqual({ x: 270, y: 1890 });
  expect(streamToDevice(1.2, -0.1, 1080, 2520)).toEqual({ x: 1079, y: 0 });
});

const size = () => ({ w: 100, h: 200 });

test("left press on the screen starts a touch, moves follow, release ends it", () => {
  const t = new TouchTracker(size);
  // A real pointermove carries button === -1; only buttons (the held-button
  // bitmask) says the left button is still down. See findings C1.
  const down = t.handle({ kind: "down", button: 0, buttons: 1, hit: { x: 0.5, y: 0.5 } });
  const move = t.handle({ kind: "move", button: -1, buttons: 1, hit: { x: 0.6, y: 0.5 } });
  const up = t.handle({ kind: "up", button: 0, buttons: 0, hit: { x: 0.6, y: 0.5 } });
  expect([...down, ...move, ...up].map((i) => i.type === "touch" && i.action)).toEqual(["down", "move", "up"]);
  expect(down[0]).toMatchObject({ pointerId: -1, x: 50, y: 100, videoWidth: 100, videoHeight: 200 });
});

test("moves without a pressed button are ignored", () => {
  expect(new TouchTracker(size).handle({ kind: "move", button: -1, buttons: 0, hit: { x: 0.5, y: 0.5 } })).toEqual([]);
});

test("dragging off the screen keeps the touch at the edge, release outside still ends it", () => {
  const t = new TouchTracker(size);
  t.handle({ kind: "down", button: 0, buttons: 1, hit: { x: 0.9, y: 0.5 } });
  expect(t.handle({ kind: "move", button: -1, buttons: 1, hit: null })).toEqual([]);
  expect(t.handle({ kind: "up", button: 0, buttons: 0, hit: null })[0]).toMatchObject({ type: "touch", action: "up", x: 90 });
});

test("losing focus or leaving the window mid-touch cancels it", () => {
  const t = new TouchTracker(size);
  t.handle({ kind: "down", button: 0, buttons: 1, hit: { x: 0.5, y: 0.5 } });
  expect(t.handle({ kind: "blur", button: 0, buttons: 0, hit: null })[0]).toMatchObject({ type: "touch", action: "cancel" });
  expect(t.handle({ kind: "up", button: 0, buttons: 0, hit: null })).toEqual([]);
});

test("right click is back-or-screen-on, middle click is HOME", () => {
  const t = new TouchTracker(size);
  expect(t.handle({ kind: "down", button: 2, buttons: 2, hit: { x: 0.5, y: 0.5 } })).toEqual([{ type: "back-or-screen-on", action: "down" }]);
  expect(t.handle({ kind: "up", button: 2, buttons: 0, hit: { x: 0.5, y: 0.5 } })).toEqual([{ type: "back-or-screen-on", action: "up" }]);
  expect(t.handle({ kind: "down", button: 1, buttons: 4, hit: { x: 0.5, y: 0.5 } })[0]).toMatchObject({ type: "key", action: "down", keyCode: 3 });
});

test("middle click sends HOME up only when its down was sent (M12)", () => {
  const t = new TouchTracker(size);
  const down = t.handle({ kind: "down", button: 1, buttons: 4, hit: { x: 0.5, y: 0.5 } });
  const up = t.handle({ kind: "up", button: 1, buttons: 0, hit: { x: 0.5, y: 0.5 } });
  expect(down).toEqual([{ type: "key", action: "down", keyCode: 3, repeat: 0, metaState: 0 }]);
  expect(up).toEqual([{ type: "key", action: "up", keyCode: 3, repeat: 0, metaState: 0 }]);

  // A pointerup for the middle button with no matching down (e.g. the press
  // started off canvas) must not emit a stray HOME up.
  expect(new TouchTracker(size).handle({ kind: "up", button: 1, buttons: 0, hit: { x: 0.5, y: 0.5 } })).toEqual([]);
});

test("no stream yet means no intents", () => {
  expect(new TouchTracker(() => null).handle({ kind: "down", button: 0, buttons: 1, hit: { x: 0.5, y: 0.5 } })).toEqual([]);
});

const touches = (intents: ReturnType<TouchTracker["handle"]>) =>
  intents.map((i) => (i.type === "touch" ? { action: i.action, id: i.pointerId, x: i.x, y: i.y } : null));

test("mirrorPoint inverts through the centre of the screen per axis, as scrcpy's virtual finger", () => {
  const size = { w: 100, h: 200 };
  expect(mirrorPoint({ x: 30, y: 50 }, size, true, true)).toEqual({ x: 70, y: 150 });
  expect(mirrorPoint({ x: 30, y: 50 }, size, true, false)).toEqual({ x: 70, y: 50 });
  expect(mirrorPoint({ x: 30, y: 50 }, size, false, true)).toEqual({ x: 30, y: 150 });
  expect(mirrorPoint({ x: 0, y: 0 }, size, true, true)).toEqual({ x: 99, y: 199 });
});

test("Ctrl+drag pinches: a second finger mirrored through the centre moves with the first", () => {
  const t = new TouchTracker(size);
  const down = t.handle({ kind: "down", button: 0, buttons: 1, hit: { x: 0.3, y: 0.25 }, ctrl: true });
  const move = t.handle({ kind: "move", button: -1, buttons: 1, hit: { x: 0.2, y: 0.2 } });
  const up = t.handle({ kind: "up", button: 0, buttons: 0, hit: { x: 0.2, y: 0.2 } });
  expect(touches(down)).toEqual([
    { action: "down", id: -2, x: 30, y: 50 },
    { action: "down", id: -3, x: 70, y: 150 },
  ]);
  expect(touches(move)).toEqual([
    { action: "move", id: -2, x: 20, y: 40 },
    { action: "move", id: -3, x: 80, y: 160 },
  ]);
  expect(touches(up)).toEqual([
    { action: "up", id: -2, x: 20, y: 40 },
    { action: "up", id: -3, x: 80, y: 160 },
  ]);
});

test("Shift+drag slides two fingers vertically, Ctrl+Shift+drag horizontally", () => {
  const vertical = new TouchTracker(size).handle({ kind: "down", button: 0, buttons: 1, hit: { x: 0.3, y: 0.25 }, shift: true });
  expect(touches(vertical)[1]).toEqual({ action: "down", id: -3, x: 70, y: 50 });
  const horizontal = new TouchTracker(size).handle({ kind: "down", button: 0, buttons: 1, hit: { x: 0.3, y: 0.25 }, ctrl: true, shift: true });
  expect(touches(horizontal)[1]).toEqual({ action: "down", id: -3, x: 30, y: 150 });
});

test("the gesture's modifiers are read at press time only, and a blur cancels both fingers", () => {
  const t = new TouchTracker(size);
  t.handle({ kind: "down", button: 0, buttons: 1, hit: { x: 0.5, y: 0.5 }, ctrl: true });
  const cancel = t.handle({ kind: "blur", button: 0, buttons: 0, hit: null });
  expect(touches(cancel).map((c) => c?.action)).toEqual(["cancel", "cancel"]);
  const plain = t.handle({ kind: "down", button: 0, buttons: 1, hit: { x: 0.5, y: 0.5 } });
  expect(touches(plain)).toEqual([{ action: "down", id: -1, x: 50, y: 100 }]);
});

test("the 4th button is APP_SWITCH and the 5th expands the notification panel", () => {
  const t = new TouchTracker(size);
  expect(t.handle({ kind: "down", button: 3, buttons: 8, hit: null })).toEqual([{ type: "key", action: "down", keyCode: 187, repeat: 0, metaState: 0 }]);
  expect(t.handle({ kind: "up", button: 3, buttons: 0, hit: null })).toEqual([{ type: "key", action: "up", keyCode: 187, repeat: 0, metaState: 0 }]);
  expect(t.handle({ kind: "down", button: 4, buttons: 16, hit: null })).toEqual([{ type: "expand-notifications" }]);
  expect(t.handle({ kind: "up", button: 4, buttons: 0, hit: null })).toEqual([]);
});
