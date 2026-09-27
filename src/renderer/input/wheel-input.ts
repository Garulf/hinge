import { isWheelNotch, ScrollSmoother, wheelToScroll, type ChromiumWheelDeltas } from "../../shared/scroll-smoother";
import { streamToDevice, type StreamPoint } from "../../shared/touch";
import { WheelSwipe } from "../../shared/wheel-swipe";
import type { ControlIntent } from "../../shared/wire";

export interface ScrollFeel {
  /** How long a notch sent as scroll events eases out over; 0 sends it at once. */
  smoothingMs: number;
  speed: number;
  /** "swipe" moves a finger for each burst of notches; scroll events otherwise. A touchpad always sends scroll events. */
  style?: "swipe" | "events";
}

export interface WheelInputDeps {
  send(intent: ControlIntent): void;
  videoSize(): { w: number; h: number } | null;
  /** How a wheel notch reaches the phone and how far it scrolls, read on every wheel event. */
  scrolling(): ScrollFeel;
  /** While this holds, a notch still easing out and a swipe still moving stop. */
  halted(): boolean;
  requestFrame(callback: (time: number) => void): void;
}

export type WheelEventLike = Pick<WheelEvent, "deltaX" | "deltaY" | "buttons" | "timeStamp"> & ChromiumWheelDeltas;

const FRAME_MS = 1000 / 60;

type ScrollTarget = Omit<Extract<ControlIntent, { type: "scroll" }>, "type" | "scrollX" | "scrollY">;

/** Turns wheel events over the stream into scroll events or finger swipes on the phone. */
export class WheelInput {
  readonly #deps: WheelInputDeps;
  readonly #scroll = new ScrollSmoother();
  readonly #swipe = new WheelSwipe();
  #swipeFrameWaiting = false;
  #scrollTarget: ScrollTarget | null = null;
  #scrollFrameAt: number | null = null;

  constructor(deps: WheelInputDeps) {
    this.#deps = deps;
  }

  /** `touching`: a finger is already down, so a notch scrolls rather than starting a second finger's swipe. */
  wheel(e: WheelEventLike, hit: StreamPoint, touching: boolean): void {
    const size = this.#deps.videoSize();
    if (!size) return;
    const feel = this.#deps.scrolling();
    const delta = wheelToScroll(e.deltaX, e.deltaY, feel.speed);
    const notch = isWheelNotch(e);
    if (notch && feel.style === "swipe" && !touching) {
      this.#swipeNotch(delta, { x: hit.x * size.w, y: hit.y * size.h }, size, e.timeStamp);
      return;
    }
    const point = streamToDevice(hit.x, hit.y, size.w, size.h);
    this.#scrollTarget = { x: point.x, y: point.y, videoWidth: size.w, videoHeight: size.h, buttons: e.buttons };
    this.#scroll.add(delta.x, delta.y);
    if (this.#scrollFrameAt !== null) return;
    this.#sendScroll(FRAME_MS, notch ? feel.smoothingMs : 0);
    this.#scheduleScroll(e.timeStamp);
  }

  cancelSwipe(): void {
    for (const intent of this.#swipe.cancel()) this.#deps.send(intent);
  }

  #swipeNotch(units: { x: number; y: number }, at: { x: number; y: number }, size: { w: number; h: number }, time: number): void {
    for (const intent of this.#swipe.add(units, at, size, time)) this.#deps.send(intent);
    this.#requestSwipeFrame();
  }

  #requestSwipeFrame(): void {
    if (this.#swipeFrameWaiting || !this.#swipe.busy) return;
    this.#swipeFrameWaiting = true;
    this.#deps.requestFrame((time) => this.#onSwipeFrame(time));
  }

  /** The finger lets go without a fling when the input halts or the stream changes size under it. */
  #onSwipeFrame(time: number): void {
    this.#swipeFrameWaiting = false;
    const held = this.#swipe.stream;
    const size = this.#deps.videoSize();
    const streamChanged = held !== null && (size?.w !== held.w || size?.h !== held.h);
    const stop = this.#deps.halted() || streamChanged;
    for (const intent of stop ? this.#swipe.cancel() : this.#swipe.frame(time)) this.#deps.send(intent);
    this.#requestSwipeFrame();
  }

  #scheduleScroll(sentAt: number): void {
    if (this.#scroll.idle) {
      this.#scrollFrameAt = null;
      return;
    }
    this.#scrollFrameAt = sentAt;
    this.#deps.requestFrame((time) => this.#onScrollFrame(time));
  }

  /** A notch still easing out stops when the input halts, as a fresh wheel event would. */
  #onScrollFrame(time: number): void {
    if (this.#deps.halted()) this.#scroll.clear();
    else this.#sendScroll(Math.max(0, time - (this.#scrollFrameAt ?? time)), this.#deps.scrolling().smoothingMs);
    this.#scheduleScroll(time);
  }

  #sendScroll(elapsedMs: number, smoothingMs: number): void {
    const target = this.#scrollTarget;
    const slice = this.#scroll.take(elapsedMs, smoothingMs);
    if (!target || (slice.x === 0 && slice.y === 0)) return;
    this.#deps.send({ type: "scroll", ...target, scrollX: slice.x, scrollY: slice.y });
  }
}
