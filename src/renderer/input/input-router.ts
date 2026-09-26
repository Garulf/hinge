import * as THREE from "three";
import { KeyTracker, type KeyEventLike } from "../../shared/keymap";
import { RotateGesture, type Point } from "../../shared/model-rotation";
import { ModifierTracker, type ModifierKey } from "../../shared/modifiers";
import { WheelSteps } from "../../shared/scale";
import { isWheelNotch, ScrollSmoother, wheelToScroll, type ChromiumWheelDeltas } from "../../shared/scroll-smoother";
import { insideScreenMask, screenUvToStream } from "../../shared/screen-uv";
import { DEFAULT_MODIFIERS, ShortcutHandler, type HingeAction } from "../../shared/shortcuts";
import { streamToDevice, TouchTracker, type PointerEventLike, type StreamPoint } from "../../shared/touch";
import { WheelSwipe } from "../../shared/wheel-swipe";
import type { ControlIntent } from "../../shared/wire";
import type { PhoneScene } from "../scene/phone-scene";

const CHROME_FIELDS = "[data-chrome] input, [data-chrome] select, [data-chrome] textarea";

/** Keys typed into the window's own form fields (the pairing form, say) are not the phone's. */
function typedIntoChrome(target: EventTarget | null): boolean {
  return Boolean((target as { closest?: (selector: string) => unknown } | null)?.closest?.(CHROME_FIELDS));
}

function pointOf(e: PointerEvent): Point {
  return { x: e.clientX, y: e.clientY };
}

export interface InputRouterOptions {
  onAction?: (action: HingeAction) => void;
  /** The configured shortcut modifiers, read on every key event so a settings change applies at once. */
  modifiers?: () => readonly ModifierKey[];
  /** While the display is paused nothing but shortcuts reaches the phone, as in scrcpy. */
  paused?: () => boolean;
  /** An Alt+drag turn of the model ended ("moved"), or an Alt+double-click asked for it to go back to rest ("reset"). */
  onRotated?: (outcome: "moved" | "reset") => void;
  /** An Alt+left press starts turning the model while the work view is showing: switches to showcase without resetting the turn. */
  onEnterShowcase?: () => void;
  /** How a wheel notch reaches the phone and how far it scrolls, read on every wheel event. */
  scrolling?: () => ScrollFeel;
  requestFrame?: (callback: (time: number) => void) => void;
}

export interface ScrollFeel {
  /** How long a notch sent as scroll events eases out over; 0 sends it at once. */
  smoothingMs: number;
  speed: number;
  /** "swipe" moves a finger for each burst of notches; scroll events otherwise. A touchpad always sends scroll events. */
  style?: "swipe" | "events";
}

const FRAME_MS = 1000 / 60;

type ScrollTarget = Omit<Extract<ControlIntent, { type: "scroll" }>, "type" | "scrollX" | "scrollY">;

/**
 * What a press does, fixed at pointerdown until release: a touch on the
 * phone, a window drag, a showcase orbit, an Alt+drag turn of the model, or
 * nothing (pressed while the view transition ran).
 */
type PressMode = "touch" | "drag" | "orbit" | "rotate" | "ignored";

export class InputRouter {
  readonly #canvas: HTMLCanvasElement;
  readonly #scene: PhoneScene;
  readonly #videoSize: () => { w: number; h: number } | null;
  readonly #send: (intent: ControlIntent) => void;
  readonly #onAction: (action: HingeAction) => void;
  readonly #touch: TouchTracker;
  readonly #keys = new KeyTracker();
  readonly #modifiers = new ModifierTracker();
  readonly #shortcuts: ShortcutHandler;
  readonly #paused: () => boolean;
  readonly #wheelSteps = new WheelSteps();
  readonly #raycaster = new THREE.Raycaster();
  readonly #rotate = new RotateGesture();
  readonly #onRotated: (outcome: "moved" | "reset") => void;
  readonly #onEnterShowcase: () => void;
  readonly #scrolling: () => ScrollFeel;
  readonly #requestFrame: (callback: (time: number) => void) => void;
  readonly #scroll = new ScrollSmoother();
  readonly #swipe = new WheelSwipe();
  #swipeFrameWaiting = false;
  #scrollTarget: ScrollTarget | null = null;
  #scrollFrameAt: number | null = null;
  #press: PressMode | null = null;
  /** Whether the current rotate press has moved the model, so a plain Alt+click saves nothing. */
  #turned = false;
  /** A drag or orbit press held still while the view transition runs. */
  #heldForTransition = false;
  #lastPointer = { x: 0, y: 0 };

  constructor(
    canvas: HTMLCanvasElement,
    scene: PhoneScene,
    videoSize: () => { w: number; h: number } | null,
    send: (intent: ControlIntent) => void,
    opts: InputRouterOptions = {},
  ) {
    this.#canvas = canvas;
    this.#scene = scene;
    this.#videoSize = videoSize;
    this.#send = send;
    this.#onAction = opts.onAction ?? (() => {});
    this.#touch = new TouchTracker(videoSize);
    this.#shortcuts = new ShortcutHandler(this.#modifiers, opts.modifiers ?? (() => DEFAULT_MODIFIERS));
    this.#paused = opts.paused ?? (() => false);
    this.#onRotated = opts.onRotated ?? (() => {});
    this.#onEnterShowcase = opts.onEnterShowcase ?? (() => {});
    this.#scrolling = opts.scrolling ?? (() => ({ smoothingMs: 0, speed: 1 }));
    this.#requestFrame = opts.requestFrame ?? ((callback) => requestAnimationFrame(callback));

    canvas.addEventListener("pointerdown", (e) => this.#onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.#onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.#onPointerUp(e));
    canvas.addEventListener("pointerleave", () => this.#dispatch({ kind: "leave", button: 0, buttons: 0, hit: null }));
    canvas.addEventListener("pointercancel", () => this.#cancelInteraction());
    canvas.addEventListener("lostpointercapture", () => this.#cancelInteraction());
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => this.#onWheel(e), { passive: false });
    window.addEventListener("keydown", (e) => this.#onKey(e));
    window.addEventListener("keyup", (e) => this.#onKey(e));
    window.addEventListener("blur", () => {
      this.#modifiers.clear();
      this.#releaseAll();
    });
  }

  #onPointerDown(e: PointerEvent): void {
    // Capture on every path: a bezel drag needs pointerup even if the
    // cursor ends up outside the (possibly already-moved) window, and a
    // touch or an orbit needs it for the same reason when dragged off the
    // canvas.
    this.#canvas.setPointerCapture(e.pointerId);
    this.#lastPointer = { x: e.clientX, y: e.clientY };
    this.#heldForTransition = false;
    const view = this.#scene.view();
    if (view.active) {
      this.#press = "ignored";
      this.#rotate.otherPress();
      return;
    }
    if (e.button === 0 && this.#altHeld()) {
      this.#press = "rotate";
      this.#turned = false;
      if (view.target === "work") this.#onEnterShowcase();
      this.#rotate.press(pointOf(e), this.#scene.modelRotation(), e.timeStamp);
      return;
    }
    this.#rotate.otherPress();
    const hit = this.#hitOf(e);
    if (e.button === 0 && !hit) {
      if (view.t === 1 && !e.shiftKey) {
        this.#press = "orbit";
        return;
      }
      this.#press = "drag";
      window.hinge.beginDrag();
      return;
    }
    this.#cancelSwipe();
    this.#press = e.button === 0 ? "touch" : null;
    this.#dispatch({ kind: "down", button: e.button, buttons: e.buttons, hit, ctrl: e.ctrlKey, shift: e.shiftKey });
  }

  #onPointerMove(e: PointerEvent): void {
    const dx = e.clientX - this.#lastPointer.x;
    const dy = e.clientY - this.#lastPointer.y;
    this.#lastPointer = { x: e.clientX, y: e.clientY };
    if (this.#press === "ignored") return;
    if (this.#press === "rotate") {
      const angles = this.#rotate.move(pointOf(e));
      if (angles) {
        this.#scene.setModelRotation(angles);
        this.#turned = true;
      }
      return;
    }
    if (this.#press === "drag" || this.#press === "orbit") {
      if (this.#scene.view().active) {
        this.#pauseForTransition();
        return;
      }
      if (this.#heldForTransition) this.#resumeAfterTransition();
      if (this.#press === "orbit") this.#scene.orbitBy(dx, dy);
      return;
    }
    if (this.#scene.view().active) return;
    this.#dispatch({ kind: "move", button: e.button, buttons: e.buttons, hit: this.#hitOf(e) });
  }

  #onPointerUp(e: PointerEvent): void {
    if (this.#canvas.hasPointerCapture(e.pointerId)) this.#canvas.releasePointerCapture(e.pointerId);
    const press = this.#press;
    this.#press = null;
    if (press === "rotate") {
      this.#endRotate(this.#rotate.release(pointOf(e), e.timeStamp));
      return;
    }
    this.#endPress(press);
    if (press === "drag" || press === "orbit" || press === "ignored") return;
    this.#dispatch({ kind: "up", button: e.button, buttons: e.buttons, hit: this.#scene.view().active ? null : this.#hitOf(e) });
  }

  /** Lets go of every touch and key the phone still has held, before focus is lost or the display pauses. */
  #releaseAll(): void {
    this.#cancelSwipe();
    this.#cancelInteraction();
    for (const intent of [...this.#shortcuts.flush(), ...this.#keys.flush()]) this.#send(intent);
  }

  /** Ends a drag or an orbit and cancels a touch on blur, pointercancel and lostpointercapture. */
  #cancelInteraction(): void {
    const press = this.#press;
    this.#press = null;
    this.#endPress(press);
    this.#dispatch({ kind: "blur", button: 0, buttons: 0, hit: null });
  }

  #endPress(press: PressMode | null): void {
    if (press === "drag" && !this.#heldForTransition) window.hinge.endDrag();
    else if (press === "orbit") this.#scene.releaseOrbit();
    else if (press === "rotate") {
      // Cut short by a blur or a lost capture, the turn stays where it got to.
      this.#rotate.cancel();
      this.#endRotate("keep");
    }
    this.#heldForTransition = false;
  }

  #endRotate(outcome: "keep" | "reset"): void {
    const turned = this.#turned;
    this.#turned = false;
    if (outcome === "reset") this.#onRotated("reset");
    else if (turned) this.#onRotated("moved");
  }

  /** The view toggle springs the turn back to rest, so the rest of this drag must not pull it away again. */
  #stopRotateForToggle(): void {
    if (this.#press !== "rotate") return;
    this.#press = "ignored";
    this.#turned = false;
    this.#rotate.cancel();
  }

  #altHeld(): boolean {
    return this.#modifiers.held("lalt") || this.#modifiers.held("ralt");
  }

  /** Main moves a dragged window on its own timer, so the drag ends outright rather than just ignoring moves. */
  #pauseForTransition(): void {
    if (this.#heldForTransition || (this.#press !== "drag" && this.#press !== "orbit")) return;
    this.#heldForTransition = true;
    if (this.#press === "drag") window.hinge.endDrag();
  }

  #resumeAfterTransition(): void {
    this.#heldForTransition = false;
    if (this.#press === "drag") window.hinge.beginDrag();
  }

  #onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (this.#scene.view().active) return;
    if (this.#shortcuts.modHeld()) {
      const steps = this.#wheelSteps.add(e.deltaY);
      for (let i = 0; i < Math.abs(steps); i++) this.#onAction(steps > 0 ? "scale-down" : "scale-up");
      return;
    }
    if (this.#paused()) return;
    const hit = this.#hitOf(e);
    const size = this.#videoSize();
    if (!hit || !size) return;
    const feel = this.#scrolling();
    const delta = wheelToScroll(e.deltaX, e.deltaY, feel.speed);
    const notch = isWheelNotch(e as WheelEvent & ChromiumWheelDeltas);
    if (notch && feel.style === "swipe" && this.#press !== "touch") {
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

  #swipeNotch(units: { x: number; y: number }, at: { x: number; y: number }, size: { w: number; h: number }, time: number): void {
    for (const intent of this.#swipe.add(units, at, size, time)) this.#send(intent);
    this.#requestSwipeFrame();
  }

  #requestSwipeFrame(): void {
    if (this.#swipeFrameWaiting || !this.#swipe.busy) return;
    this.#swipeFrameWaiting = true;
    this.#requestFrame((time) => this.#onSwipeFrame(time));
  }

  /** The finger lets go without a fling when the view starts moving, the display pauses or the stream changes size under it. */
  #onSwipeFrame(time: number): void {
    this.#swipeFrameWaiting = false;
    const held = this.#swipe.stream;
    const size = this.#videoSize();
    const streamChanged = held !== null && (size?.w !== held.w || size?.h !== held.h);
    const stop = this.#scene.view().active || this.#paused() || streamChanged;
    for (const intent of stop ? this.#swipe.cancel() : this.#swipe.frame(time)) this.#send(intent);
    this.#requestSwipeFrame();
  }

  #cancelSwipe(): void {
    for (const intent of this.#swipe.cancel()) this.#send(intent);
  }

  #scheduleScroll(sentAt: number): void {
    if (this.#scroll.idle) {
      this.#scrollFrameAt = null;
      return;
    }
    this.#scrollFrameAt = sentAt;
    this.#requestFrame((time) => this.#onScrollFrame(time));
  }

  /** A notch still easing out stops when the view starts moving or the display pauses, as a fresh wheel event would. */
  #onScrollFrame(time: number): void {
    if (this.#scene.view().active || this.#paused()) this.#scroll.clear();
    else this.#sendScroll(Math.max(0, time - (this.#scrollFrameAt ?? time)), this.#scrolling().smoothingMs);
    this.#scheduleScroll(time);
  }

  #sendScroll(elapsedMs: number, smoothingMs: number): void {
    const target = this.#scrollTarget;
    const slice = this.#scroll.take(elapsedMs, smoothingMs);
    if (!target || (slice.x === 0 && slice.y === 0)) return;
    this.#send({ type: "scroll", ...target, scrollX: slice.x, scrollY: slice.y });
  }

  #onKey(e: KeyboardEvent): void {
    const like: KeyEventLike = {
      type: e.type as "keydown" | "keyup",
      code: e.code,
      key: e.key,
      repeat: e.repeat,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
    };
    this.#modifiers.handle(like);
    if (typedIntoChrome(e.target)) return;
    // A key already held down on the phone stays the phone's until released,
    // even if MOD is pressed meanwhile: its repeats and its up go to it.
    const heldOnPhone = this.#keys.holds(like.code) && (like.type === "keyup" || like.repeat);
    const shortcut = heldOnPhone ? null : this.#shortcuts.handle(like, this.#paused());
    if (shortcut) {
      if (shortcut.claimed) e.preventDefault();
      for (const intent of shortcut.intents) this.#send(intent);
      if (shortcut.action === "pause") this.#releaseAll();
      if (shortcut.action === "toggle-view") {
        this.#stopRotateForToggle();
        this.#pauseForTransition();
      }
      if (shortcut.action) this.#onAction(shortcut.action);
      return;
    }
    if (this.#paused()) return;
    const intents = this.#keys.handle(like);
    // Only claim the key when it actually produced something to send to the
    // phone; an unclaimed key (Alt+F4, Alt+Space, ...) must still reach the
    // OS, which preventDefault() unconditionally blocked before.
    if (intents.length > 0) e.preventDefault();
    for (const intent of intents) this.#send(intent);
  }

  /** While paused the tracker never sees a press, so none can end or move after resuming without its down. */
  #dispatch(e: PointerEventLike): void {
    if (this.#paused()) return;
    for (const intent of this.#touch.handle(e)) this.#send(intent);
  }

  /** Where a press at this client point would touch the stream, or null off the lit screen. */
  streamPointAt(clientX: number, clientY: number): StreamPoint | null {
    return this.#hitOf({ clientX, clientY });
  }

  /**
   * Only the lit screen takes touches: a press on the dark or folded-away
   * screen, its masked-off corners, the body or around the phone is a bezel
   * press. three raycasts the skinned inner screen in its current (bent) pose.
   */
  #hitOf(e: { clientX: number; clientY: number }): StreamPoint | null {
    const screen = this.#scene.litScreen();
    if (!screen) return null;
    const rect = this.#canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
    this.#raycaster.setFromCamera(ndc, this.#scene.activeCamera());
    const [hit] = this.#raycaster.intersectObject(screen.mesh);
    if (!hit?.uv) return null;
    if (!insideScreenMask(hit.uv.x, hit.uv.y, screen.extras.cornerRadiusUv, screen.extras.pixelSize)) return null;
    return screenUvToStream(hit.uv.x, hit.uv.y, this.#scene.rotation());
  }
}
