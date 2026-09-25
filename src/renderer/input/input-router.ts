import * as THREE from "three";
import { KeyTracker, type KeyEventLike } from "../../shared/keymap";
import { ModifierTracker } from "../../shared/modifiers";
import { insideScreenMask, screenUvToStream } from "../../shared/screen-uv";
import { hingeShortcut, type HingeAction } from "../../shared/shortcuts";
import { streamToDevice, TouchTracker, type StreamPoint } from "../../shared/touch";
import type { ControlIntent } from "../../shared/wire";
import type { PhoneScene } from "../scene/phone-scene";

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export interface InputRouterOptions {
  onAction?: (action: HingeAction) => void;
}

/**
 * What a press does, fixed at pointerdown until release: a touch on the
 * phone, a window drag, a showcase orbit, or nothing (pressed while the view
 * transition ran).
 */
type PressMode = "touch" | "drag" | "orbit" | "ignored";

export class InputRouter {
  readonly #canvas: HTMLCanvasElement;
  readonly #scene: PhoneScene;
  readonly #videoSize: () => { w: number; h: number } | null;
  readonly #send: (intent: ControlIntent) => void;
  readonly #onAction: (action: HingeAction) => void;
  readonly #touch: TouchTracker;
  readonly #keys = new KeyTracker();
  readonly #modifiers = new ModifierTracker();
  readonly #raycaster = new THREE.Raycaster();
  #press: PressMode | null = null;
  /** A drag or orbit press held still while the view transition runs. */
  #paused = false;
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
      this.#cancelInteraction();
      this.#modifiers.clear();
      for (const intent of this.#keys.flush()) this.#send(intent);
    });
  }

  #onPointerDown(e: PointerEvent): void {
    // Capture on every path: a bezel drag needs pointerup even if the
    // cursor ends up outside the (possibly already-moved) window, and a
    // touch or an orbit needs it for the same reason when dragged off the
    // canvas.
    this.#canvas.setPointerCapture(e.pointerId);
    this.#lastPointer = { x: e.clientX, y: e.clientY };
    this.#paused = false;
    const view = this.#scene.view();
    if (view.active) {
      this.#press = "ignored";
      return;
    }
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
    this.#press = e.button === 0 ? "touch" : null;
    this.#dispatch({ kind: "down", button: e.button, buttons: e.buttons, hit });
  }

  #onPointerMove(e: PointerEvent): void {
    const dx = e.clientX - this.#lastPointer.x;
    const dy = e.clientY - this.#lastPointer.y;
    this.#lastPointer = { x: e.clientX, y: e.clientY };
    if (this.#press === "ignored") return;
    if (this.#press === "drag" || this.#press === "orbit") {
      if (this.#scene.view().active) {
        this.#pauseForTransition();
        return;
      }
      if (this.#paused) this.#resumeAfterTransition();
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
    this.#endPress(press);
    if (press === "drag" || press === "orbit" || press === "ignored") return;
    this.#dispatch({ kind: "up", button: e.button, buttons: e.buttons, hit: this.#scene.view().active ? null : this.#hitOf(e) });
  }

  /** Ends a drag or an orbit and cancels a touch on blur, pointercancel and lostpointercapture. */
  #cancelInteraction(): void {
    const press = this.#press;
    this.#press = null;
    this.#endPress(press);
    this.#dispatch({ kind: "blur", button: 0, buttons: 0, hit: null });
  }

  #endPress(press: PressMode | null): void {
    if (press === "drag" && !this.#paused) window.hinge.endDrag();
    else if (press === "orbit") this.#scene.releaseOrbit();
    this.#paused = false;
  }

  /** Main moves a dragged window on its own timer, so the drag ends outright rather than just ignoring moves. */
  #pauseForTransition(): void {
    if (this.#paused || (this.#press !== "drag" && this.#press !== "orbit")) return;
    this.#paused = true;
    if (this.#press === "drag") window.hinge.endDrag();
  }

  #resumeAfterTransition(): void {
    this.#paused = false;
    if (this.#press === "drag") window.hinge.beginDrag();
  }

  #onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (this.#scene.view().active) return;
    const hit = this.#hitOf(e);
    const size = this.#videoSize();
    if (!hit || !size) return;
    const point = streamToDevice(hit.x, hit.y, size.w, size.h);
    this.#send({
      type: "scroll",
      x: point.x,
      y: point.y,
      videoWidth: size.w,
      videoHeight: size.h,
      scrollX: clamp(-e.deltaX / 100, -1, 1),
      scrollY: clamp(-e.deltaY / 100, -1, 1),
      buttons: e.buttons,
    });
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
    const action = hingeShortcut(like, this.#modifiers);
    if (action) {
      e.preventDefault();
      if (action === "toggle-view") this.#pauseForTransition();
      this.#onAction(action);
      return;
    }
    const intents = this.#keys.handle(like);
    // Only claim the key when it actually produced something to send to the
    // phone; an unclaimed key (Alt+F4, Alt+Space, ...) must still reach the
    // OS, which preventDefault() unconditionally blocked before.
    if (intents.length > 0) e.preventDefault();
    for (const intent of intents) this.#send(intent);
  }

  #dispatch(e: { kind: "down" | "move" | "up" | "leave" | "blur"; button: number; buttons: number; hit: StreamPoint | null }): void {
    for (const intent of this.#touch.handle(e)) this.#send(intent);
  }

  /**
   * Only the lit screen takes touches: a press on the dark or folded-away
   * screen, its masked-off corners, the body or around the phone is a bezel
   * press. three raycasts the skinned inner screen in its current (bent) pose.
   */
  #hitOf(e: PointerEvent | WheelEvent): StreamPoint | null {
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
