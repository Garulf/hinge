import type { ModifierKey } from "../../shared/modifiers";
import { popoutAllows } from "../../shared/popout";
import { TouchTracker, type PointerEventLike, type StreamPoint } from "../../shared/touch";
import type { ControlIntent } from "../../shared/wire";
import { KeyInput, keyEventLike } from "../input/key-input";
import { WheelInput, type ScrollFeel } from "../input/wheel-input";

export interface VideoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a video of this size sits when fitted, centred, inside the canvas. */
export function videoRectIn(canvasW: number, canvasH: number, videoW: number, videoH: number): VideoRect {
  const scale = Math.min(canvasW / videoW, canvasH / videoH);
  const width = videoW * scale;
  const height = videoH * scale;
  return { x: (canvasW - width) / 2, y: (canvasH - height) / 2, width, height };
}

export interface FlatInputOptions {
  /** The configured shortcut modifiers, read on every key event. */
  modifiers?: () => readonly ModifierKey[];
  scrolling?: () => ScrollFeel;
  requestFrame?: (callback: (time: number) => void) => void;
  /** Whether the frame is fitted inside the canvas; false while it is stretched to the whole canvas. Defaults to fitted. */
  fitted?: () => boolean;
}

/** HOME, recents and the notification shade stay the main window's; a pop-out takes touches and BACK only. */
const POPOUT_BUTTONS = new Set([0, 2]);

/** A pop-out's input: its canvas is the phone's display, shown flat, so every press on the video is a touch. */
export class FlatInput {
  readonly #canvas: HTMLCanvasElement;
  readonly #videoSize: () => { w: number; h: number } | null;
  readonly #send: (intent: ControlIntent) => void;
  readonly #touch: TouchTracker;
  readonly #keys: KeyInput;
  readonly #wheel: WheelInput;
  readonly #fitted: () => boolean;
  #touching = false;

  constructor(canvas: HTMLCanvasElement, videoSize: () => { w: number; h: number } | null, send: (intent: ControlIntent) => void, opts: FlatInputOptions = {}) {
    this.#canvas = canvas;
    this.#videoSize = videoSize;
    this.#send = send;
    this.#touch = new TouchTracker(videoSize);
    this.#keys = new KeyInput(opts.modifiers, popoutAllows);
    this.#fitted = opts.fitted ?? (() => true);
    this.#wheel = new WheelInput({
      send,
      videoSize,
      scrolling: opts.scrolling ?? (() => ({ smoothingMs: 0, speed: 1 })),
      halted: () => false,
      requestFrame: opts.requestFrame ?? ((callback) => requestAnimationFrame(callback)),
    });

    canvas.addEventListener("pointerdown", (e) => this.#onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.#dispatch({ kind: "move", button: e.button, buttons: e.buttons, hit: this.#hitOf(e) }));
    canvas.addEventListener("pointerup", (e) => this.#onPointerUp(e));
    canvas.addEventListener("pointerleave", () => this.#dispatch({ kind: "leave", button: 0, buttons: 0, hit: null }));
    canvas.addEventListener("pointercancel", () => this.#cancel());
    canvas.addEventListener("lostpointercapture", () => this.#cancel());
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => this.#onWheel(e), { passive: false });
    // A file dropped on the window would otherwise replace the page.
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());
    window.addEventListener("keydown", (e) => this.#onKey(e));
    window.addEventListener("keyup", (e) => this.#onKey(e));
    window.addEventListener("blur", () => {
      this.#keys.forgetModifiers();
      this.#wheel.cancelSwipe();
      this.#cancel();
      for (const intent of this.#keys.release()) this.#send(intent);
    });
  }

  #onPointerDown(e: PointerEvent): void {
    this.#canvas.setPointerCapture(e.pointerId);
    this.#wheel.cancelSwipe();
    if (!POPOUT_BUTTONS.has(e.button)) return;
    if (e.button === 0) this.#touching = true;
    this.#dispatch({ kind: "down", button: e.button, buttons: e.buttons, hit: this.#hitOf(e), ctrl: e.ctrlKey, shift: e.shiftKey });
  }

  #onPointerUp(e: PointerEvent): void {
    if (this.#canvas.hasPointerCapture(e.pointerId)) this.#canvas.releasePointerCapture(e.pointerId);
    if (!POPOUT_BUTTONS.has(e.button)) return;
    if (e.button === 0) this.#touching = false;
    this.#dispatch({ kind: "up", button: e.button, buttons: e.buttons, hit: this.#hitOf(e) });
  }

  #cancel(): void {
    this.#touching = false;
    this.#dispatch({ kind: "blur", button: 0, buttons: 0, hit: null });
  }

  #onWheel(e: WheelEvent): void {
    e.preventDefault();
    const hit = this.#hitOf(e);
    if (hit) this.#wheel.wheel(e, hit, this.#touching);
  }

  #onKey(e: KeyboardEvent): void {
    const like = keyEventLike(e);
    this.#keys.track(like);
    const outcome = this.#keys.route(like, false);
    if (outcome.claimed) e.preventDefault();
    for (const intent of outcome.intents) this.#send(intent);
  }

  #dispatch(e: PointerEventLike): void {
    for (const intent of this.#touch.handle(e)) this.#send(intent);
  }

  /** Where a press at this client point lands on the video, or null in the bars around it. */
  #hitOf(e: { clientX: number; clientY: number }): StreamPoint | null {
    const size = this.#videoSize();
    if (!size) return null;
    const bounds = this.#canvas.getBoundingClientRect();
    const rect = this.#fitted() ? videoRectIn(bounds.width, bounds.height, size.w, size.h) : { x: 0, y: 0, width: bounds.width, height: bounds.height };
    const x = (e.clientX - bounds.left - rect.x) / rect.width;
    const y = (e.clientY - bounds.top - rect.y) / rect.height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }
}
