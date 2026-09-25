import { unionSize } from "./layout";
import type { Rotation } from "./screen-uv";

export interface Size {
  w: number;
  h: number;
}

const NUDGE_AFTER_MS = 500;
const MAX_NUDGES = 2;

function sameSize(a: Size, b: Size): boolean {
  return a.w === b.w && a.h === b.h;
}

/**
 * Sizes the window for a fold: while the model animates the window covers
 * both the start and end poses (so nothing clips mid-fold), and it only
 * shrinks to the final pose once the animation has settled.
 */
export class WindowSizer {
  readonly #request: (size: Size, rotation: Rotation) => void;
  #requested: Size | null = null;
  #rotation: Rotation | null = null;
  #target: Size | null = null;
  #mismatchSinceMs: number | null = null;
  #nudges = 0;

  constructor(request: (size: Size, rotation: Rotation) => void) {
    this.#request = request;
  }

  update(target: Size, rotation: Rotation, settled: boolean): void {
    if (!this.#requested || rotation !== this.#rotation) {
      this.#target = target;
      this.#send(target, rotation);
      return;
    }
    if (!this.#target || !sameSize(target, this.#target)) {
      this.#target = target;
      this.#send(unionSize(this.#requested, target), rotation);
    }
    if (settled) this.#send(target, rotation);
  }

  /**
   * On X11 a resize requested while the compositor is stalled can leave the
   * page at its old size even though the window system took the new one,
   * and asking for the same size again is then a no-op; a one pixel detour
   * gets it through.
   */
  verify(actual: Size, nowMs: number): void {
    const requested = this.#requested;
    if (!requested || this.#rotation === null || sameSize(actual, requested)) {
      this.#mismatchSinceMs = null;
      return;
    }
    if (this.#mismatchSinceMs === null) {
      this.#mismatchSinceMs = nowMs;
      return;
    }
    if (nowMs - this.#mismatchSinceMs < NUDGE_AFTER_MS || this.#nudges >= MAX_NUDGES) return;
    this.#nudges++;
    this.#mismatchSinceMs = nowMs;
    this.#request({ w: requested.w + 1, h: requested.h }, this.#rotation);
    this.#request(requested, this.#rotation);
  }

  #send(size: Size, rotation: Rotation): void {
    if (this.#requested && rotation === this.#rotation && sameSize(size, this.#requested)) return;
    this.#requested = size;
    this.#rotation = rotation;
    this.#mismatchSinceMs = null;
    this.#nudges = 0;
    this.#request(size, rotation);
  }
}
