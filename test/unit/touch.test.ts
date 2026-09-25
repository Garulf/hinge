import { expect, test } from "vitest";
import { streamToDevice, TouchTracker, uvToDevice } from "../../src/shared/touch";

test("uv origin is bottom-left, device origin is top-left, result is clamped", () => {
  expect(uvToDevice(0, 1, 1080, 2520)).toEqual({ x: 0, y: 0 });
  expect(uvToDevice(1, 0, 1080, 2520)).toEqual({ x: 1079, y: 2519 });
  expect(uvToDevice(0.5, 0.5, 1080, 2520)).toEqual({ x: 540, y: 1260 });
  expect(uvToDevice(1.2, -0.1, 1080, 2520)).toEqual({ x: 1079, y: 2519 });
});

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
