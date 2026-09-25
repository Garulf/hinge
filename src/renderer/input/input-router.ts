import * as THREE from "three";
import { KeyTracker, type KeyEventLike } from "../../shared/keymap";
import { ModifierTracker, type ModifierKey } from "../../shared/modifiers";
import { WheelSteps } from "../../shared/scale";
import { insideScreenMask, screenUvToStream } from "../../shared/screen-uv";
import { DEFAULT_MODIFIERS, ShortcutHandler, type HingeAction } from "../../shared/shortcuts";
import { streamToDevice, TouchTracker, type PointerEventLike, type StreamPoint } from "../../shared/touch";
import type { ControlIntent } from "../../shared/wire";
import type { PhoneScene } from "../scene/phone-scene";

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

const CHROME_FIELDS = "[data-chrome] input, [data-chrome] select, [data-chrome] textarea";

/** Keys typed into the window's own form fields (the pairing form, say) are not the phone's. */
function typedIntoChrome(target: EventTarget | null): boolean {
  return Boolean((target as { closest?: (selector: string) => unknown } | null)?.closest?.(CHROME_FIELDS));
}

export interface InputRouterOptions {
  onAction?: (action: HingeAction) => void;
  /** The configured shortcut modifiers, read on every key event so a settings change applies at once. */
  modifiers?: () => readonly ModifierKey[];
  /** While the display is paused nothing but shortcuts reaches the phone, as in scrcpy. */
  paused?: () => boolean;
}

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
  #dragging = false;

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
    const hit = this.#hitOf(e);
    // Capture on both paths: a bezel drag needs pointerup even if the
    // cursor ends up outside the (possibly already-moved) window, and a
    // touch needs it for the same reason when dragged off the canvas.
    this.#canvas.setPointerCapture(e.pointerId);
    if (e.button === 0 && !hit) {
      this.#dragging = true;
      window.hinge.beginDrag();
      return;
    }
    this.#dispatch({ kind: "down", button: e.button, buttons: e.buttons, hit, ctrl: e.ctrlKey, shift: e.shiftKey });
  }

  #onPointerMove(e: PointerEvent): void {
    if (this.#dragging) return;
    this.#dispatch({ kind: "move", button: e.button, buttons: e.buttons, hit: this.#hitOf(e) });
  }

  #onPointerUp(e: PointerEvent): void {
    if (this.#canvas.hasPointerCapture(e.pointerId)) this.#canvas.releasePointerCapture(e.pointerId);
    if (this.#dragging) {
      this.#dragging = false;
      window.hinge.endDrag();
      return;
    }
    this.#dispatch({ kind: "up", button: e.button, buttons: e.buttons, hit: this.#hitOf(e) });
  }

  /** Lets go of every touch and key the phone still has held, before focus is lost or the display pauses. */
  #releaseAll(): void {
    this.#cancelInteraction();
    for (const intent of [...this.#shortcuts.flush(), ...this.#keys.flush()]) this.#send(intent);
  }

  /** Resets drag and touch state on blur, pointercancel and lostpointercapture. */
  #cancelInteraction(): void {
    if (this.#dragging) {
      this.#dragging = false;
      window.hinge.endDrag();
    }
    this.#dispatch({ kind: "blur", button: 0, buttons: 0, hit: null });
  }

  #onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (this.#shortcuts.modHeld()) {
      const steps = this.#wheelSteps.add(e.deltaY);
      for (let i = 0; i < Math.abs(steps); i++) this.#onAction(steps > 0 ? "scale-down" : "scale-up");
      return;
    }
    if (this.#paused()) return;
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
    if (typedIntoChrome(e.target)) return;
    // A key already held down on the phone stays the phone's until released,
    // even if MOD is pressed meanwhile: its repeats and its up go to it.
    const heldOnPhone = this.#keys.holds(like.code) && (like.type === "keyup" || like.repeat);
    const shortcut = heldOnPhone ? null : this.#shortcuts.handle(like, this.#paused());
    if (shortcut) {
      if (shortcut.claimed) e.preventDefault();
      for (const intent of shortcut.intents) this.#send(intent);
      if (shortcut.action === "pause") this.#releaseAll();
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
    this.#raycaster.setFromCamera(ndc, this.#scene.camera());
    const [hit] = this.#raycaster.intersectObject(screen.mesh);
    if (!hit?.uv) return null;
    if (!insideScreenMask(hit.uv.x, hit.uv.y, screen.extras.cornerRadiusUv, screen.extras.pixelSize)) return null;
    return screenUvToStream(hit.uv.x, hit.uv.y, this.#scene.rotation());
  }
}
