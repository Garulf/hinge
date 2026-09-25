import * as THREE from "three";
import { keyIntents, type KeyEventLike } from "../../shared/keymap";
import { TouchTracker, uvToDevice } from "../../shared/touch";
import type { ControlIntent } from "../../shared/wire";
import type { PhoneScene } from "../scene/phone-scene";

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export class InputRouter {
  readonly #canvas: HTMLCanvasElement;
  readonly #scene: PhoneScene;
  readonly #videoSize: () => { w: number; h: number } | null;
  readonly #send: (intent: ControlIntent) => void;
  readonly #touch: TouchTracker;
  readonly #raycaster = new THREE.Raycaster();
  #dragging = false;

  constructor(canvas: HTMLCanvasElement, scene: PhoneScene, videoSize: () => { w: number; h: number } | null, send: (intent: ControlIntent) => void) {
    this.#canvas = canvas;
    this.#scene = scene;
    this.#videoSize = videoSize;
    this.#send = send;
    this.#touch = new TouchTracker(videoSize);

    canvas.addEventListener("pointerdown", (e) => this.#onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.#onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.#onPointerUp(e));
    canvas.addEventListener("pointerleave", () => this.#dispatch({ kind: "leave", button: 0, buttons: 0, hit: null }));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => this.#onWheel(e), { passive: false });
    window.addEventListener("keydown", (e) => this.#onKey(e));
    window.addEventListener("keyup", (e) => this.#onKey(e));
    window.addEventListener("blur", () => this.#dispatch({ kind: "blur", button: 0, buttons: 0, hit: null }));
  }

  #onPointerDown(e: PointerEvent): void {
    const hit = this.#hitOf(e);
    if (e.button === 0 && !hit) {
      this.#dragging = true;
      window.hinge.beginDrag();
      return;
    }
    this.#canvas.setPointerCapture(e.pointerId);
    this.#dispatch({ kind: "down", button: e.button, buttons: e.buttons, hit });
  }

  #onPointerMove(e: PointerEvent): void {
    if (this.#dragging) return;
    this.#dispatch({ kind: "move", button: e.button, buttons: e.buttons, hit: this.#hitOf(e) });
  }

  #onPointerUp(e: PointerEvent): void {
    if (this.#dragging) {
      this.#dragging = false;
      window.hinge.endDrag();
      return;
    }
    this.#dispatch({ kind: "up", button: e.button, buttons: e.buttons, hit: this.#hitOf(e) });
  }

  #onWheel(e: WheelEvent): void {
    e.preventDefault();
    const hit = this.#hitOf(e);
    const size = this.#videoSize();
    if (!hit || !size) return;
    const point = uvToDevice(hit.u, hit.v, size.w, size.h);
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
    for (const intent of keyIntents(like)) this.#send(intent);
  }

  #dispatch(e: { kind: "down" | "move" | "up" | "leave" | "blur"; button: number; buttons: number; hit: { u: number; v: number } | null }): void {
    for (const intent of this.#touch.handle(e)) this.#send(intent);
  }

  #hitOf(e: PointerEvent | WheelEvent): { u: number; v: number } | null {
    const rect = this.#canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
    this.#raycaster.setFromCamera(ndc, this.#scene.camera());
    const [hit] = this.#raycaster.intersectObject(this.#scene.screenMesh());
    if (!hit?.uv) return null;
    return { u: hit.uv.x, v: hit.uv.y };
  }
}
