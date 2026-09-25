import type { ControlIntent, TouchAction } from "./wire";

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/** A point on the stream image, normalised: x right and y down, 0..1. */
export interface StreamPoint {
  x: number;
  y: number;
}

export function streamToDevice(x: number, y: number, videoWidth: number, videoHeight: number): { x: number; y: number } {
  return {
    x: clamp(Math.round(x * videoWidth), 0, videoWidth - 1),
    y: clamp(Math.round(y * videoHeight), 0, videoHeight - 1),
  };
}

/** ctrl and shift matter only on a left press on the screen, where they start a two-finger gesture. */
export type PointerEventLike = {
  kind: "down" | "move" | "up" | "leave" | "blur";
  button: number;
  buttons: number;
  hit: StreamPoint | null;
  ctrl?: boolean;
  shift?: boolean;
};

/** scrcpy's pointer ids: the mouse, a real finger, and the simulated second finger. */
const POINTER_MOUSE = -1;
const POINTER_FINGER = -2;
const POINTER_VIRTUAL_FINGER = -3;

const BUTTON_KEYS: Record<number, number> = { 1: 3, 3: 187 };
const FIFTH_BUTTON = 4;

interface DevicePoint {
  x: number;
  y: number;
}

interface VirtualFinger {
  invertX: boolean;
  invertY: boolean;
}

/** The virtual finger's position, inverted through the centre of the screen on the chosen axes. */
export function mirrorPoint(point: DevicePoint, size: { w: number; h: number }, invertX: boolean, invertY: boolean): DevicePoint {
  return {
    x: invertX ? clamp(size.w - point.x, 0, size.w - 1) : point.x,
    y: invertY ? clamp(size.h - point.y, 0, size.h - 1) : point.y,
  };
}

/**
 * Left-button touches, plus scrcpy's mouse bindings: right is BACK (or
 * screen on), middle HOME, 4th APP_SWITCH, 5th the notification panel.
 * Ctrl, Shift or both held at the press add a mirrored virtual finger
 * (pinch/rotate, vertical and horizontal two-finger slides).
 */
export class TouchTracker {
  #size: () => { w: number; h: number } | null;
  #touch: DevicePoint | null = null;
  #virtual: VirtualFinger | null = null;
  #rightDown = false;
  readonly #buttonsDown = new Set<number>();

  constructor(size: () => { w: number; h: number } | null) {
    this.#size = size;
  }

  handle(e: PointerEventLike): ControlIntent[] {
    if (e.kind === "blur" || e.kind === "leave") return this.#cancel();
    // A real pointermove carries button === -1 (no button "caused" the
    // event); which button is held is in the buttons bitmask instead.
    if (e.kind === "move") return e.buttons & 1 ? this.#move(e) : [];
    if (e.button === 2) return this.#handleRight(e);
    if (e.button in BUTTON_KEYS) return this.#handleButtonKey(e, BUTTON_KEYS[e.button]);
    if (e.button === FIFTH_BUTTON) return e.kind === "down" ? [{ type: "expand-notifications" }] : [];
    if (e.button === 0) return this.#handleLeft(e);
    return [];
  }

  #handleLeft(e: PointerEventLike): ControlIntent[] {
    if (e.kind === "down") return this.#start(e);
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

  #handleButtonKey(e: PointerEventLike, keyCode: number): ControlIntent[] {
    if (e.kind === "down" && !this.#buttonsDown.has(e.button)) {
      this.#buttonsDown.add(e.button);
      return [{ type: "key", action: "down", keyCode, repeat: 0, metaState: 0 }];
    }
    if (e.kind === "up" && this.#buttonsDown.delete(e.button)) {
      return [{ type: "key", action: "up", keyCode, repeat: 0, metaState: 0 }];
    }
    return [];
  }

  #start(e: PointerEventLike): ControlIntent[] {
    const size = this.#size();
    if (!size || !e.hit) return [];
    this.#touch = streamToDevice(e.hit.x, e.hit.y, size.w, size.h);
    this.#virtual = e.ctrl || e.shift ? { invertX: Boolean(e.ctrl) !== Boolean(e.shift), invertY: Boolean(e.ctrl) } : null;
    return this.#intents("down", size, this.#touch);
  }

  #move(e: PointerEventLike): ControlIntent[] {
    if (!this.#touch || !e.hit) return [];
    const size = this.#size();
    if (!size) return [];
    this.#touch = streamToDevice(e.hit.x, e.hit.y, size.w, size.h);
    return this.#intents("move", size, this.#touch);
  }

  #end(): ControlIntent[] {
    return this.#release("up");
  }

  #cancel(): ControlIntent[] {
    this.#rightDown = false;
    this.#buttonsDown.clear();
    return this.#release("cancel");
  }

  #release(action: "up" | "cancel"): ControlIntent[] {
    if (!this.#touch) return [];
    const size = this.#size();
    const point = this.#touch;
    this.#touch = null;
    const intents = size ? this.#intents(action, size, point) : [];
    this.#virtual = null;
    return intents;
  }

  #intents(action: TouchAction, size: { w: number; h: number }, point: DevicePoint): ControlIntent[] {
    const virtual = this.#virtual;
    if (!virtual) return [touchIntent(action, POINTER_MOUSE, size, point)];
    return [
      touchIntent(action, POINTER_FINGER, size, point),
      touchIntent(action, POINTER_VIRTUAL_FINGER, size, mirrorPoint(point, size, virtual.invertX, virtual.invertY)),
    ];
  }
}

function touchIntent(action: TouchAction, pointerId: number, size: { w: number; h: number }, point: DevicePoint): ControlIntent {
  const released = action === "up" || action === "cancel";
  return {
    type: "touch",
    action,
    pointerId,
    x: point.x,
    y: point.y,
    videoWidth: size.w,
    videoHeight: size.h,
    pressure: released ? 0 : 1,
    buttons: released ? 0 : 1,
  };
}
