import type { ControlIntent, TouchAction } from "./wire";

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export function uvToDevice(u: number, v: number, videoWidth: number, videoHeight: number): { x: number; y: number } {
  return {
    x: clamp(Math.round(u * videoWidth), 0, videoWidth - 1),
    y: clamp(Math.round((1 - v) * videoHeight), 0, videoHeight - 1),
  };
}

export type PointerEventLike = { kind: "down" | "move" | "up" | "leave" | "blur"; button: number; buttons: number; hit: { u: number; v: number } | null };

const HOME_KEYCODE = 3;

interface TrackedTouch {
  x: number;
  y: number;
}

export class TouchTracker {
  #size: () => { w: number; h: number } | null;
  #touch: TrackedTouch | null = null;
  #rightDown = false;

  constructor(size: () => { w: number; h: number } | null) {
    this.#size = size;
  }

  handle(e: PointerEventLike): ControlIntent[] {
    if (e.kind === "blur" || e.kind === "leave") return this.#cancel();
    if (e.button === 2) return this.#handleRight(e);
    if (e.button === 1) return this.#handleMiddle(e);
    if (e.button === 0) return this.#handleLeft(e);
    return [];
  }

  #handleLeft(e: PointerEventLike): ControlIntent[] {
    if (e.kind === "down") return this.#start(e);
    if (e.kind === "move") return this.#move(e);
    if (e.kind === "up") return this.#end();
    return [];
  }

  #handleRight(e: PointerEventLike): ControlIntent[] {
    if (e.kind === "down" && !this.#rightDown) {
      this.#rightDown = true;
      return [{ type: "back-or-screen-on", action: "down" }];
    }
    if (e.kind === "up" && this.#rightDown) {
      this.#rightDown = false;
      return [{ type: "back-or-screen-on", action: "up" }];
    }
    return [];
  }

  #handleMiddle(e: PointerEventLike): ControlIntent[] {
    if (e.kind === "down") return [{ type: "key", action: "down", keyCode: HOME_KEYCODE, repeat: 0, metaState: 0 }];
    if (e.kind === "up") return [{ type: "key", action: "up", keyCode: HOME_KEYCODE, repeat: 0, metaState: 0 }];
    return [];
  }

  #start(e: PointerEventLike): ControlIntent[] {
    const size = this.#size();
    if (!size || !e.hit) return [];
    const point = uvToDevice(e.hit.u, e.hit.v, size.w, size.h);
    this.#touch = point;
    return [this.#intent("down", size, point)];
  }

  #move(e: PointerEventLike): ControlIntent[] {
    if (!this.#touch || !e.hit) return [];
    const size = this.#size();
    if (!size) return [];
    this.#touch = uvToDevice(e.hit.u, e.hit.v, size.w, size.h);
    return [this.#intent("move", size, this.#touch)];
  }

  #end(): ControlIntent[] {
    if (!this.#touch) return [];
    const size = this.#size();
    const point = this.#touch;
    this.#touch = null;
    if (!size) return [];
    return [this.#intent("up", size, point)];
  }

  #cancel(): ControlIntent[] {
    this.#rightDown = false;
    if (!this.#touch) return [];
    const size = this.#size();
    const point = this.#touch;
    this.#touch = null;
    if (!size) return [];
    return [this.#intent("cancel", size, point)];
  }

  #intent(action: TouchAction, size: { w: number; h: number }, point: TrackedTouch): ControlIntent {
    return {
      type: "touch",
      action,
      pointerId: -1,
      x: point.x,
      y: point.y,
      videoWidth: size.w,
      videoHeight: size.h,
      pressure: action === "up" || action === "cancel" ? 0 : 1,
      buttons: action === "up" || action === "cancel" ? 0 : 1,
    };
  }
}
