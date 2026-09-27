import { afterEach, beforeEach, expect, test } from "vitest";
import { FlatInput, videoRectIn } from "../../src/renderer/popout/flat-input";
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
      const event = { preventDefault: () => {}, timeStamp: performance.now(), ...e };
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
}

function fakeCanvas(width: number, height: number) {
  const captured = new Set<number>();
  return {
    ...fakeTarget(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }) as DOMRect,
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    hasPointerCapture: (id: number) => captured.has(id),
  };
}

let fakeWindow: ReturnType<typeof fakeTarget>;

beforeEach(() => {
  fakeWindow = fakeTarget();
  (globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow;
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

function setup(canvasSize: { w: number; h: number }, video: { w: number; h: number }, style: "swipe" | "events" = "events") {
  const canvas = fakeCanvas(canvasSize.w, canvasSize.h);
  const sent: ControlIntent[] = [];
  new FlatInput(canvas as unknown as HTMLCanvasElement, () => video, (intent) => sent.push(intent), {
    scrolling: () => ({ smoothingMs: 0, speed: 1, style }),
  });
  return { canvas, sent };
}

function key(type: "keydown" | "keyup", code: string, mods: { alt?: boolean; shift?: boolean } = {}) {
  return { type, code, key: code.replace(/^Key/, "").toLowerCase(), repeat: false, ctrlKey: false, altKey: Boolean(mods.alt), metaKey: false, shiftKey: Boolean(mods.shift) };
}

test("videoRectIn fills a canvas of the video's own aspect", () => {
  expect(videoRectIn(400, 800, 400, 800)).toEqual({ x: 0, y: 0, width: 400, height: 800 });
  expect(videoRectIn(200, 400, 400, 800)).toEqual({ x: 0, y: 0, width: 200, height: 400 });
});

test("videoRectIn pillarboxes a video narrower than the canvas", () => {
  expect(videoRectIn(800, 800, 400, 800)).toEqual({ x: 200, y: 0, width: 400, height: 800 });
});

test("videoRectIn letterboxes a video wider than the canvas", () => {
  expect(videoRectIn(800, 800, 800, 400)).toEqual({ x: 0, y: 200, width: 800, height: 400 });
});

test("a press at the centre of the canvas touches the centre of the video", () => {
  const { canvas, sent } = setup({ w: 400, h: 800 }, { w: 400, h: 800 });

  canvas.fire("pointerdown", { pointerId: 1, button: 0, buttons: 1, clientX: 200, clientY: 400 });

  expect(sent).toEqual([{ type: "touch", action: "down", pointerId: -1, x: 200, y: 400, videoWidth: 400, videoHeight: 800, pressure: 1, buttons: 1 }]);
});

test("a press in the letterbox bars touches nothing", () => {
  const { canvas, sent } = setup({ w: 800, h: 800 }, { w: 400, h: 800 });

  canvas.fire("pointerdown", { pointerId: 1, button: 0, buttons: 1, clientX: 100, clientY: 400 });

  expect(sent).toEqual([]);
});

test("a press maps through the letterboxed rect onto the video", () => {
  const { canvas, sent } = setup({ w: 800, h: 800 }, { w: 400, h: 800 });

  canvas.fire("pointerdown", { pointerId: 1, button: 0, buttons: 1, clientX: 300, clientY: 200 });

  expect(sent[0]).toMatchObject({ type: "touch", action: "down", x: 100, y: 200 });
});

test("MOD+h does nothing in a pop-out while MOD+b is BACK", () => {
  const { sent } = setup({ w: 400, h: 800 }, { w: 400, h: 800 });

  fakeWindow.fire("keydown", key("keydown", "AltLeft", { alt: true }));
  fakeWindow.fire("keydown", key("keydown", "KeyH", { alt: true }));
  fakeWindow.fire("keyup", key("keyup", "KeyH", { alt: true }));
  expect(sent).toEqual([]);

  fakeWindow.fire("keydown", key("keydown", "KeyB", { alt: true }));
  fakeWindow.fire("keyup", key("keyup", "KeyB", { alt: true }));
  expect(sent).toEqual([
    { type: "key", action: "down", keyCode: 4, repeat: 0, metaState: 0 },
    { type: "key", action: "up", keyCode: 4, repeat: 0, metaState: 0 },
  ]);
});

test("plain typing reaches the phone", () => {
  const { sent } = setup({ w: 400, h: 800 }, { w: 400, h: 800 });

  fakeWindow.fire("keydown", key("keydown", "KeyH"));

  expect(sent).toEqual([{ type: "text", text: "h" }]);
});

test("a wheel notch with the events style scrolls at the mapped point", () => {
  const { canvas, sent } = setup({ w: 400, h: 800 }, { w: 400, h: 800 }, "events");

  canvas.fire("wheel", { deltaX: 0, deltaY: 100, buttons: 0, clientX: 200, clientY: 400 });

  expect(sent).toEqual([expect.objectContaining({ type: "scroll", x: 200, y: 400, videoWidth: 400, videoHeight: 800, scrollY: -1 })]);
});
