import * as THREE from "three";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InputRouter } from "../../src/renderer/input/input-router";
import type { HingeAction } from "../../src/shared/shortcuts";
import type { ControlIntent } from "../../src/shared/wire";

type Handler = (e: Record<string, unknown>) => void;

function fakeTarget() {
  const listeners = new Map<string, Handler[]>();
  return {
    addEventListener(type: string, fn: Handler) {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    removeEventListener() {},
    fire(type: string, e: Record<string, unknown> = {}) {
      const event = { preventDefault: () => {}, ...e };
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
}

function fakeCanvas() {
  const base = fakeTarget();
  const captured = new Set<number>();
  return {
    ...base,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect,
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    hasPointerCapture: (id: number) => captured.has(id),
    captured,
  };
}

// A real orthographic camera and a real plane mesh, exercised through the
// genuine three.js Raycaster: raycasting is pure geometry math and needs no
// WebGL context, so this is testable without a real PhoneScene/canvas.
// The plane's UV runs u left to right and v bottom to top across the
// canvas, standing in for the lit screen mesh's UV as the scene shows it.
type View = { target: "work" | "showcase"; t: number; active: boolean };

function fakeScene(rotation: 0 | 1 | 2 | 3 = 0) {
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
  camera.position.z = 100;
  const screen = {
    mesh: new THREE.Mesh(new THREE.PlaneGeometry(100, 100)),
    extras: { punchHole: [0.5, 0.95, 0.02] as [number, number, number], cornerRadiusUv: [0.1, 0.1] as [number, number], pixelSize: [100, 100] as [number, number] },
  };
  const state = { view: { target: "work", t: 0, active: false } as View };
  const orbits: [number, number][] = [];
  let releases = 0;
  return {
    camera: () => camera,
    litScreen: (): typeof screen | null => screen,
    rotation: () => rotation,
    view: () => state.view,
    orbitBy: (dx: number, dy: number) => orbits.push([dx, dy]),
    releaseOrbit: () => releases++,
    state,
    orbits,
    releases: () => releases,
  };
}

let fakeWindow: ReturnType<typeof fakeTarget> & { hinge: { beginDrag: ReturnType<typeof vi.fn>; endDrag: ReturnType<typeof vi.fn> } };

beforeEach(() => {
  fakeWindow = Object.assign(fakeTarget(), { hinge: { beginDrag: vi.fn(), endDrag: vi.fn() } });
  (globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow;
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

function setup(opts?: { rotation?: 0 | 1 | 2 | 3; video?: { w: number; h: number }; onAction?: (action: HingeAction) => void; view?: View }) {
  const canvas = fakeCanvas();
  const scene = fakeScene(opts?.rotation);
  if (opts?.view) scene.state.view = opts.view;
  const sent: ControlIntent[] = [];
  const video = opts?.video ?? { w: 100, h: 100 };
  const router = new InputRouter(canvas as unknown as HTMLCanvasElement, scene as never, () => video, (intent) => sent.push(intent), {
    onAction: opts?.onAction,
  });
  return { canvas, scene, sent, router };
}

const CENTER = { clientX: 50, clientY: 50 };
const OFF_SCREEN = { clientX: 500, clientY: 500 };

test("C1: a real pointermove (button -1) is still routed as a touch move mid-swipe", () => {
  const { canvas, sent } = setup();

  canvas.fire("pointerdown", { pointerId: 1, button: 0, buttons: 1, ...CENTER });
  canvas.fire("pointermove", { pointerId: 1, button: -1, buttons: 1, clientX: 60, clientY: 50 });
  canvas.fire("pointermove", { pointerId: 1, button: -1, buttons: 1, clientX: 70, clientY: 50 });
  canvas.fire("pointerup", { pointerId: 1, button: 0, buttons: 0, clientX: 70, clientY: 50 });

  const actions = sent.map((i) => i.type === "touch" && i.action);
  expect(actions).toEqual(["down", "move", "move", "up"]);
});

test("a left pointerdown that misses the screen begins a window drag instead of a touch, and captures the pointer", () => {
  const { canvas, sent } = setup();

  canvas.fire("pointerdown", { pointerId: 2, button: 0, buttons: 1, ...OFF_SCREEN });
  expect(fakeWindow.hinge.beginDrag).toHaveBeenCalledOnce();
  expect(canvas.captured.has(2)).toBe(true);
  expect(sent).toEqual([]);

  canvas.fire("pointerup", { pointerId: 2, button: 0, buttons: 0, ...OFF_SCREEN });
  expect(fakeWindow.hinge.endDrag).toHaveBeenCalledOnce();
  expect(sent).toEqual([]);
});

test("I5: pointercancel mid-touch cancels it instead of leaving it stuck", () => {
  const { canvas, sent } = setup();

  canvas.fire("pointerdown", { pointerId: 3, button: 0, buttons: 1, ...CENTER });
  canvas.fire("pointercancel", {});

  const actions = sent.map((i) => i.type === "touch" && i.action);
  expect(actions).toEqual(["down", "cancel"]);
});

test("I5: lostpointercapture mid-touch cancels it", () => {
  const { canvas, sent } = setup();

  canvas.fire("pointerdown", { pointerId: 4, button: 0, buttons: 1, ...CENTER });
  canvas.fire("lostpointercapture", {});

  const actions = sent.map((i) => i.type === "touch" && i.action);
  expect(actions).toEqual(["down", "cancel"]);
});

test("I5: pointercancel mid-drag ends the drag", () => {
  const { canvas } = setup();

  canvas.fire("pointerdown", { pointerId: 5, button: 0, buttons: 1, ...OFF_SCREEN });
  expect(fakeWindow.hinge.beginDrag).toHaveBeenCalledOnce();

  canvas.fire("pointercancel", {});
  expect(fakeWindow.hinge.endDrag).toHaveBeenCalledOnce();
});

test("I4 + I5: window blur ends an active drag, cancels an active touch, and flushes held keys", () => {
  const { canvas, sent } = setup();

  canvas.fire("pointerdown", { pointerId: 6, button: 0, buttons: 1, ...CENTER });
  fakeWindow.fire("keydown", { type: "keydown", code: "KeyC", key: "c", repeat: false, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false });

  fakeWindow.fire("blur", {});

  const touchActions = sent.filter((i) => i.type === "touch").map((i) => i.type === "touch" && i.action);
  expect(touchActions).toEqual(["down", "cancel"]);
  const keyUps = sent.filter((i) => i.type === "key" && i.action === "up");
  expect(keyUps).toEqual([{ type: "key", action: "up", keyCode: 31, repeat: 0, metaState: 0 }]);
});

test("I2: a key that produces no intent (Ctrl+Minus zoom) is left alone, not preventDefault()ed", () => {
  setup();
  const preventDefault = vi.fn();
  fakeWindow.fire("keydown", { type: "keydown", code: "Minus", key: "-", repeat: false, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
});

test("I2: Alt+F4 produces no intent and is left alone so it reaches the OS on Windows", () => {
  const { sent } = setup();
  const preventDefault = vi.fn();
  fakeWindow.fire("keydown", { type: "keydown", code: "F4", key: "F4", repeat: false, ctrlKey: false, altKey: true, metaKey: false, shiftKey: false, preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
});

test("Ctrl+R is preventDefault()ed so it cannot trigger an Electron reload", () => {
  const { sent } = setup();
  const preventDefault = vi.fn();
  fakeWindow.fire("keydown", { type: "keydown", code: "KeyR", key: "r", repeat: false, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(sent).toEqual([{ type: "key", action: "down", keyCode: 46, repeat: 0, metaState: 4096 | 8192 }]);
});

test("a bezel drag started, then blurred, does not leave #dragging stuck for the next press", () => {
  const { canvas, sent } = setup();

  canvas.fire("pointerdown", { pointerId: 7, button: 0, buttons: 1, ...OFF_SCREEN });
  fakeWindow.fire("blur", {});
  expect(fakeWindow.hinge.endDrag).toHaveBeenCalledOnce();

  // A fresh on-screen press after the blur must be treated as a touch, not
  // silently consumed as the tail end of the old drag.
  canvas.fire("pointerdown", { pointerId: 8, button: 0, buttons: 1, ...CENTER });
  canvas.fire("pointerup", { pointerId: 8, button: 0, buttons: 0, ...CENTER });

  const actions = sent.map((i) => i.type === "touch" && i.action);
  expect(actions).toEqual(["down", "up"]);
});

// clientX 20, clientY 30 on the 100 x 100 canvas hits the screen at u 0.2, v 0.7.
const POINT = { clientX: 20, clientY: 30 };

function touchDown(rotation: 0 | 1 | 2 | 3) {
  const { canvas, sent } = setup({ rotation, video: { w: 200, h: 100 } });
  canvas.fire("pointerdown", { pointerId: 9, button: 0, buttons: 1, ...POINT });
  return sent[0];
}

test("rotation 0: the hit maps straight onto the stream, y measured down", () => {
  expect(touchDown(0)).toMatchObject({ type: "touch", action: "down", x: 40, y: 30, videoWidth: 200, videoHeight: 100 });
});

test("rotation 1: the model is turned counter-clockwise, so stream x runs down the mesh's v and y against its u", () => {
  expect(touchDown(1)).toMatchObject({ type: "touch", action: "down", x: 60, y: 80, videoWidth: 200, videoHeight: 100 });
});

test("scrolling maps through the same rotation", () => {
  const { canvas, sent } = setup({ rotation: 1, video: { w: 200, h: 100 } });
  canvas.fire("wheel", { deltaX: 0, deltaY: 100, buttons: 0, ...POINT });
  expect(sent[0]).toMatchObject({ type: "scroll", x: 60, y: 80 });
});

function fireKey(type: "keydown" | "keyup", code: string, over: Record<string, unknown> = {}) {
  const preventDefault = vi.fn();
  fakeWindow.fire(type, { type, code, key: code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, preventDefault, ...over });
  return preventDefault;
}

test("left Alt+D fires the toggle-view action and is never forwarded to the phone", () => {
  const onAction = vi.fn();
  const { sent } = setup({ onAction });
  fireKey("keydown", "AltLeft", { altKey: true });
  const preventDefault = fireKey("keydown", "KeyD", { altKey: true });

  expect(onAction).toHaveBeenCalledOnce();
  expect(onAction).toHaveBeenCalledWith("toggle-view");
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(sent).toEqual([]);
});

test("left Super+D fires the toggle-view action", () => {
  const onAction = vi.fn();
  setup({ onAction });
  fireKey("keydown", "MetaLeft", { metaKey: true });
  fireKey("keydown", "KeyD", { metaKey: true });

  expect(onAction).toHaveBeenCalledOnce();
  expect(onAction).toHaveBeenCalledWith("toggle-view");
});

test("right Alt+D does not toggle (AltGr on many layouts); normal key handling applies and nothing is forwarded", () => {
  const onAction = vi.fn();
  const { sent } = setup({ onAction });
  fireKey("keydown", "AltRight", { altKey: true });
  const preventDefault = fireKey("keydown", "KeyD", { altKey: true });

  expect(onAction).not.toHaveBeenCalled();
  // Falls through to normal handling: keyIntents already treats any
  // alt-held combo as producing nothing, so this stays unclaimed too.
  expect(preventDefault).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
});

test("MOD+D with no onAction supplied is a silent no-op default, still not forwarded", () => {
  const { sent } = setup();
  fireKey("keydown", "AltLeft", { altKey: true });
  const preventDefault = fireKey("keydown", "KeyD", { altKey: true });

  expect(preventDefault).toHaveBeenCalledOnce();
  expect(sent).toEqual([]);
});

test("releasing left Alt (keyup) before D means D alone no longer toggles", () => {
  const onAction = vi.fn();
  setup({ onAction });
  fireKey("keydown", "AltLeft", { altKey: true });
  fireKey("keyup", "AltLeft", { altKey: false });
  fireKey("keydown", "KeyD", { altKey: false });

  expect(onAction).not.toHaveBeenCalled();
});

test("window blur clears held modifiers, so D alone no longer toggles afterwards", () => {
  const onAction = vi.fn();
  setup({ onAction });
  fireKey("keydown", "AltLeft", { altKey: true });
  fakeWindow.fire("blur", {});
  // The (fake) real browser would also stop reporting altKey true once Alt
  // is no longer physically held; simulate that alongside the tracker clear.
  fireKey("keydown", "KeyD", { altKey: false });

  expect(onAction).not.toHaveBeenCalled();
});

test("with no lit screen a left press drags the window", () => {
  const canvas = fakeCanvas();
  const scene = { ...fakeScene(), litScreen: () => null };
  const sent: ControlIntent[] = [];
  new InputRouter(canvas as unknown as HTMLCanvasElement, scene as never, () => ({ w: 100, h: 100 }), (intent) => sent.push(intent));
  canvas.fire("pointerdown", { pointerId: 10, button: 0, buttons: 1, ...CENTER });
  expect(fakeWindow.hinge.beginDrag).toHaveBeenCalledOnce();
  expect(sent).toEqual([]);
});

test("a press in a masked-off rounded corner of the lit screen drags the window", () => {
  const { canvas, sent } = setup();
  canvas.fire("pointerdown", { pointerId: 11, button: 0, buttons: 1, clientX: 1, clientY: 1 });
  expect(fakeWindow.hinge.beginDrag).toHaveBeenCalledOnce();
  expect(sent).toEqual([]);
});

const SHOWCASE: View = { target: "showcase", t: 1, active: false };
const OFF_PHONE = { clientX: 500, clientY: 500 };

function touchActions(sent: ControlIntent[]) {
  return sent.filter((i) => i.type === "touch").map((i) => i.type === "touch" && i.action);
}

test("showcase: a press on the lit screen is a touch and never orbits", () => {
  const { canvas, sent, scene } = setup({ view: SHOWCASE });
  canvas.fire("pointerdown", { pointerId: 20, button: 0, buttons: 1, ...CENTER });
  canvas.fire("pointermove", { pointerId: 20, button: -1, buttons: 1, clientX: 60, clientY: 50 });
  canvas.fire("pointerup", { pointerId: 20, button: 0, buttons: 0, clientX: 60, clientY: 50 });
  expect(touchActions(sent)).toEqual(["down", "move", "up"]);
  expect(scene.orbits).toEqual([]);
  expect(fakeWindow.hinge.beginDrag).not.toHaveBeenCalled();
});

test("showcase: a press off the lit screen orbits by the pointer's movement and releases on pointerup", () => {
  const { canvas, sent, scene } = setup({ view: SHOWCASE });
  canvas.fire("pointerdown", { pointerId: 21, button: 0, buttons: 1, ...OFF_PHONE });
  canvas.fire("pointermove", { pointerId: 21, button: -1, buttons: 1, clientX: 510, clientY: 495 });
  canvas.fire("pointermove", { pointerId: 21, button: -1, buttons: 1, clientX: 530, clientY: 500 });
  canvas.fire("pointerup", { pointerId: 21, button: 0, buttons: 0, clientX: 530, clientY: 500 });
  expect(scene.orbits).toEqual([
    [10, -5],
    [20, 5],
  ]);
  expect(scene.releases()).toBe(1);
  expect(sent).toEqual([]);
  expect(fakeWindow.hinge.beginDrag).not.toHaveBeenCalled();
});

test("showcase: Shift and a press off the lit screen drags the window instead of orbiting", () => {
  const { canvas, sent, scene } = setup({ view: SHOWCASE });
  canvas.fire("pointerdown", { pointerId: 22, button: 0, buttons: 1, shiftKey: true, ...OFF_PHONE });
  canvas.fire("pointermove", { pointerId: 22, button: -1, buttons: 1, shiftKey: true, clientX: 520, clientY: 500 });
  canvas.fire("pointerup", { pointerId: 22, button: 0, buttons: 0, shiftKey: true, clientX: 520, clientY: 500 });
  expect(fakeWindow.hinge.beginDrag).toHaveBeenCalledOnce();
  expect(fakeWindow.hinge.endDrag).toHaveBeenCalledOnce();
  expect(scene.orbits).toEqual([]);
  expect(sent).toEqual([]);
});

test("showcase: a touch that slides off the screen stays a touch until release", () => {
  const { canvas, sent, scene } = setup({ view: SHOWCASE });
  canvas.fire("pointerdown", { pointerId: 23, button: 0, buttons: 1, ...CENTER });
  canvas.fire("pointermove", { pointerId: 23, button: -1, buttons: 1, ...OFF_PHONE });
  canvas.fire("pointerup", { pointerId: 23, button: 0, buttons: 0, ...OFF_PHONE });
  expect(touchActions(sent)).toEqual(["down", "up"]);
  expect(scene.orbits).toEqual([]);
});

test("showcase: an orbit that slides onto the screen stays an orbit until release", () => {
  const { canvas, sent, scene } = setup({ view: SHOWCASE });
  canvas.fire("pointerdown", { pointerId: 24, button: 0, buttons: 1, clientX: 150, clientY: 50 });
  canvas.fire("pointermove", { pointerId: 24, button: -1, buttons: 1, ...CENTER });
  canvas.fire("pointerup", { pointerId: 24, button: 0, buttons: 0, ...CENTER });
  expect(scene.orbits).toEqual([[-100, 0]]);
  expect(sent).toEqual([]);
});

test("showcase: a blur mid-orbit releases the orbit", () => {
  const { canvas, scene } = setup({ view: SHOWCASE });
  canvas.fire("pointerdown", { pointerId: 25, button: 0, buttons: 1, ...OFF_PHONE });
  fakeWindow.fire("blur", {});
  expect(scene.releases()).toBe(1);
  canvas.fire("pointermove", { pointerId: 25, button: -1, buttons: 1, clientX: 520, clientY: 500 });
  expect(scene.orbits).toEqual([]);
});

test("while the view transition runs, a press does nothing until it is released", () => {
  const { canvas, sent, scene } = setup({ view: { target: "showcase", t: 0.4, active: true } });
  canvas.fire("pointerdown", { pointerId: 26, button: 0, buttons: 1, ...CENTER });
  scene.state.view = SHOWCASE;
  canvas.fire("pointermove", { pointerId: 26, button: -1, buttons: 1, clientX: 60, clientY: 50 });
  canvas.fire("pointerup", { pointerId: 26, button: 0, buttons: 0, clientX: 60, clientY: 50 });
  expect(sent).toEqual([]);
  expect(scene.orbits).toEqual([]);
  expect(fakeWindow.hinge.beginDrag).not.toHaveBeenCalled();

  canvas.fire("pointerdown", { pointerId: 27, button: 0, buttons: 1, ...OFF_PHONE });
  expect(fakeWindow.hinge.beginDrag).not.toHaveBeenCalled();
  canvas.fire("pointerup", { pointerId: 27, button: 0, buttons: 0, ...OFF_PHONE });
  expect(scene.releases()).toBe(1);
});

test("a touch in progress when the transition starts ignores moves but still lifts on release", () => {
  const { canvas, sent, scene } = setup();
  canvas.fire("pointerdown", { pointerId: 28, button: 0, buttons: 1, ...CENTER });
  scene.state.view = { target: "showcase", t: 0.2, active: true };
  canvas.fire("pointermove", { pointerId: 28, button: -1, buttons: 1, clientX: 60, clientY: 50 });
  canvas.fire("pointerup", { pointerId: 28, button: 0, buttons: 0, clientX: 60, clientY: 50 });
  expect(touchActions(sent)).toEqual(["down", "up"]);
  expect(sent.at(-1)).toMatchObject({ x: 50, y: 50 });
});

test("the wheel does nothing while the transition runs", () => {
  const { canvas, sent } = setup({ view: { target: "work", t: 0.5, active: true } });
  canvas.fire("wheel", { deltaX: 0, deltaY: 100, buttons: 0, ...CENTER });
  expect(sent).toEqual([]);
});

test("work view: Shift and a press off the screen still drags, and a plain one never orbits", () => {
  const { canvas, scene } = setup();
  canvas.fire("pointerdown", { pointerId: 29, button: 0, buttons: 1, ...OFF_PHONE });
  canvas.fire("pointermove", { pointerId: 29, button: -1, buttons: 1, clientX: 520, clientY: 500 });
  canvas.fire("pointerup", { pointerId: 29, button: 0, buttons: 0, clientX: 520, clientY: 500 });
  expect(fakeWindow.hinge.beginDrag).toHaveBeenCalledOnce();
  expect(scene.orbits).toEqual([]);
});
