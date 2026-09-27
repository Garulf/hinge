import * as THREE from "three";
import { caseGrip, type Grip } from "../../shared/case-grip";
import { RotateGesture, type Point } from "../../shared/model-rotation";
import type { ModifierKey } from "../../shared/modifiers";
import { WheelSteps } from "../../shared/scale";
import { insideScreenMask, screenUvToStream } from "../../shared/screen-uv";
import type { HingeAction } from "../../shared/shortcuts";
import { TouchTracker, type PointerEventLike, type StreamPoint } from "../../shared/touch";
import type { ControlIntent } from "../../shared/wire";
import type { PhoneScene } from "../scene/phone-scene";
import { KeyInput, keyEventLike } from "./key-input";
import { WheelInput, type ScrollFeel } from "./wheel-input";

export type { ScrollFeel } from "./wheel-input";

const CHROME_FIELDS = "[data-chrome] input, [data-chrome] select, [data-chrome] textarea";

/** Keys typed into the window's own form fields (the pairing form, say) are not the phone's. */
function typedIntoChrome(target: EventTarget | null): boolean {
  return Boolean((target as { closest?: (selector: string) => unknown } | null)?.closest?.(CHROME_FIELDS));
}

/**
 * Where the pointer is on the screen. A turn reads the pointer
 * there, never in the window: the window grows and moves around a turned
 * phone, which moves client coordinates under a pointer that has not moved,
 * and the turn that follows would resize the window again.
 */
function screenPointOf(e: PointerEvent): Point {
  return { x: e.screenX, y: e.screenY };
}

export interface InputRouterOptions {
  onAction?: (action: HingeAction) => void;
  /** The configured shortcut modifiers, read on every key event so a settings change applies at once. */
  modifiers?: () => readonly ModifierKey[];
  /** While the display is paused nothing but shortcuts reaches the phone, as in scrcpy. */
  paused?: () => boolean;
  /** A turn of the model ended ("moved"), or a double-click on a turn grip asked for it to go back to straight on ("reset"). */
  onRotated?: (outcome: "moved" | "reset") => void;
  /** How a wheel notch reaches the phone and how far it scrolls, read on every wheel event. */
  scrolling?: () => ScrollFeel;
  requestFrame?: (callback: (time: number) => void) => void;
}

/**
 * What a press does, fixed at pointerdown until release: a touch on the
 * phone, a window drag, a turn of the model, or nothing (pressed while
 * Center eased the turn back).
 */
type PressMode = "touch" | "drag" | "rotate" | "ignored";

/** Over the lit screen the pointer is the phone's; over the case it shows what a press there would do. */
const GRIP_CURSOR: Record<Grip | "screen", string> = { screen: "", turn: "grab", move: "move" };

export class InputRouter {
  readonly #canvas: HTMLCanvasElement;
  readonly #scene: PhoneScene;
  readonly #videoSize: () => { w: number; h: number } | null;
  readonly #send: (intent: ControlIntent) => void;
  readonly #onAction: (action: HingeAction) => void;
  readonly #touch: TouchTracker;
  readonly #keys: KeyInput;
  readonly #wheel: WheelInput;
  readonly #paused: () => boolean;
  readonly #wheelSteps = new WheelSteps();
  readonly #raycaster = new THREE.Raycaster();
  readonly #rotate = new RotateGesture();
  readonly #onRotated: (outcome: "moved" | "reset") => void;
  #press: PressMode | null = null;
  /** Whether the current rotate press has moved the model, so a plain click saves nothing. */
  #turned = false;
  /** A window drag held still while Center eases the turn back. */
  #heldForTransition = false;
  #cursor = "";

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
    this.#keys = new KeyInput(opts.modifiers);
    this.#paused = opts.paused ?? (() => false);
    this.#onRotated = opts.onRotated ?? (() => {});
    this.#wheel = new WheelInput({
      send,
      videoSize,
      scrolling: opts.scrolling ?? (() => ({ smoothingMs: 0, speed: 1 })),
      halted: () => this.#scene.view().active || this.#paused(),
      requestFrame: opts.requestFrame ?? ((callback) => requestAnimationFrame(callback)),
    });

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
      this.#keys.forgetModifiers();
      this.#releaseAll();
    });
  }

  /**
   * A left press with Alt held turns the phone from anywhere. Otherwise the
   * lit screen takes it as a touch, the case's corners and sides turn the
   * phone, and its top and bottom (or anywhere off the phone) move the
   * window.
   */
  #onPointerDown(e: PointerEvent): void {
    // Capture on every path: a bezel drag needs pointerup even if the
    // cursor ends up outside the (possibly already-moved) window, and a
    // touch or a turn needs it for the same reason when dragged off the
    // canvas.
    this.#canvas.setPointerCapture(e.pointerId);
    this.#heldForTransition = false;
    if (this.#scene.view().active) {
      this.#press = "ignored";
      this.#rotate.otherPress();
      return;
    }
    if (e.button === 0 && this.#altHeld()) {
      this.#startTurn(e);
      return;
    }
    const hit = this.#hitOf(e);
    if (e.button === 0 && !hit) {
      if (this.#gripAt(e) === "turn") {
        this.#startTurn(e);
        return;
      }
      this.#rotate.otherPress();
      this.#press = "drag";
      window.hinge.beginDrag();
      return;
    }
    this.#rotate.otherPress();
    this.#wheel.cancelSwipe();
    this.#press = e.button === 0 ? "touch" : null;
    this.#dispatch({ kind: "down", button: e.button, buttons: e.buttons, hit, ctrl: e.ctrlKey, shift: e.shiftKey });
  }

  #startTurn(e: PointerEvent): void {
    this.#press = "rotate";
    this.#turned = false;
    this.#setCursor("grabbing");
    this.#rotate.press(screenPointOf(e), this.#scene.modelRotation(), e.timeStamp);
  }

  #onPointerMove(e: PointerEvent): void {
    if (this.#press === "ignored") return;
    if (this.#press === "rotate") {
      const angles = this.#rotate.move(screenPointOf(e));
      if (angles) {
        this.#scene.setModelRotation(angles);
        this.#turned = true;
      }
      return;
    }
    if (this.#press === "drag") {
      if (this.#scene.view().active) this.#pauseForTransition();
      else if (this.#heldForTransition) this.#resumeAfterTransition();
      return;
    }
    if (this.#scene.view().active) return;
    const hit = this.#hitOf(e);
    if (this.#press === null) this.#setCursor(GRIP_CURSOR[hit ? "screen" : this.#gripAt(e)]);
    this.#dispatch({ kind: "move", button: e.button, buttons: e.buttons, hit });
  }

  #onPointerUp(e: PointerEvent): void {
    if (this.#canvas.hasPointerCapture(e.pointerId)) this.#canvas.releasePointerCapture(e.pointerId);
    const press = this.#press;
    this.#press = null;
    if (press === "rotate") {
      this.#setCursor(GRIP_CURSOR.turn);
      this.#endRotate(this.#rotate.release(screenPointOf(e), e.timeStamp));
      return;
    }
    this.#endPress(press);
    if (press === "drag" || press === "ignored") return;
    this.#dispatch({ kind: "up", button: e.button, buttons: e.buttons, hit: this.#scene.view().active ? null : this.#hitOf(e) });
  }

  /** Lets go of every touch and key the phone still has held, before focus is lost or the display pauses. */
  #releaseAll(): void {
    this.#wheel.cancelSwipe();
    this.#cancelInteraction();
    for (const intent of this.#keys.release()) this.#send(intent);
  }

  /** Ends a drag or a turn and cancels a touch on blur, pointercancel and lostpointercapture. */
  #cancelInteraction(): void {
    const press = this.#press;
    this.#press = null;
    this.#endPress(press);
    this.#dispatch({ kind: "blur", button: 0, buttons: 0, hit: null });
  }

  #endPress(press: PressMode | null): void {
    if (press === "drag" && !this.#heldForTransition) window.hinge.endDrag();
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

  /** Center springs the turn back to rest, so the rest of this drag must not pull it away again. */
  #stopRotateForCenter(): void {
    if (this.#press !== "rotate") return;
    this.#press = "ignored";
    this.#turned = false;
    this.#rotate.cancel();
  }

  #altHeld(): boolean {
    return this.#keys.held("lalt") || this.#keys.held("ralt");
  }

  /**
   * Main moves a dragged window on its own timer, so while Center resizes
   * the window around the turn the drag ends outright rather than just
   * ignoring moves.
   */
  #pauseForTransition(): void {
    if (this.#heldForTransition || this.#press !== "drag") return;
    this.#heldForTransition = true;
    window.hinge.endDrag();
  }

  #resumeAfterTransition(): void {
    this.#heldForTransition = false;
    window.hinge.beginDrag();
  }

  #onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (this.#scene.view().active) return;
    if (this.#keys.modHeld()) {
      const steps = this.#wheelSteps.add(e.deltaY);
      for (let i = 0; i < Math.abs(steps); i++) this.#onAction(steps > 0 ? "scale-down" : "scale-up");
      return;
    }
    if (this.#paused()) return;
    const hit = this.#hitOf(e);
    if (hit) this.#wheel.wheel(e, hit, this.#press === "touch");
  }

  #onKey(e: KeyboardEvent): void {
    const like = keyEventLike(e);
    this.#keys.track(like);
    if (typedIntoChrome(e.target)) return;
    const outcome = this.#keys.route(like, this.#paused());
    if (outcome.claimed) e.preventDefault();
    for (const intent of outcome.intents) this.#send(intent);
    if (outcome.action === "pause") this.#releaseAll();
    if (outcome.action === "center") {
      this.#stopRotateForCenter();
      this.#pauseForTransition();
    }
    if (outcome.action) this.#onAction(outcome.action);
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

  /** What a left press at this client point would do: touch the phone, turn it, or move the window. */
  pressAt(clientX: number, clientY: number): "touch" | Grip {
    const at = { clientX, clientY };
    return this.#hitOf(at) ? "touch" : this.#gripAt(at);
  }

  /** Off the phone altogether (the room around a turned phone, say) a press moves the window. */
  #gripAt(e: { clientX: number; clientY: number }): Grip {
    const point = this.#scene.bodyPointAt(this.#ndcOf(e));
    return point ? caseGrip(point) : "move";
  }

  #setCursor(cursor: string): void {
    if (cursor === this.#cursor) return;
    this.#cursor = cursor;
    this.#canvas.style.cursor = cursor;
  }

  #ndcOf(e: { clientX: number; clientY: number }): THREE.Vector2 {
    const rect = this.#canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
  }

  /**
   * Only the lit screen takes touches: a press on the dark or folded-away
   * screen, its masked-off corners, the body or around the phone is a bezel
   * press. three raycasts the skinned inner screen in its current (bent) pose.
   */
  #hitOf(e: { clientX: number; clientY: number }): StreamPoint | null {
    const screen = this.#scene.litScreen();
    if (!screen) return null;
    this.#raycaster.setFromCamera(this.#ndcOf(e), this.#scene.activeCamera());
    const [hit] = this.#raycaster.intersectObject(screen.mesh);
    if (!hit?.uv) return null;
    if (!insideScreenMask(hit.uv.x, hit.uv.y, screen.extras.cornerRadiusUv, screen.extras.pixelSize)) return null;
    return screenUvToStream(hit.uv.x, hit.uv.y, this.#scene.rotation());
  }
}
