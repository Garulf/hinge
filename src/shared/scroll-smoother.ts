const WHEEL_NOTCH_PX = 100;

/** scrcpy 3.3.1 and later encode a scroll as a 16 bit float over [-16, 16]. */
const MAX_SCROLL_PER_MESSAGE = 16;

/**
 * Android views truncate each scroll event to whole pixels (one unit is about
 * 64 dp), so slices much smaller than this would lose a noticeable share of
 * every notch.
 */
export const SMALLEST_SLICE = 0.05;

/** Chromium reports a mouse wheel's notches in whole multiples of this; a touchpad's or a free-spinning wheel's fine steps are not. */
const WHEEL_DELTA_PER_NOTCH = 120;

/**
 * Whether a wheel event comes from a notched mouse wheel rather than a
 * touchpad's many small steps. Chromium's non-standard wheelDeltaX/Y carries
 * the notch count; an event without them counts as a notch.
 */
export interface ChromiumWheelDeltas {
  wheelDeltaX?: number;
  wheelDeltaY?: number;
}

export function isWheelNotch(e: ChromiumWheelDeltas): boolean {
  const { wheelDeltaX: x, wheelDeltaY: y } = e;
  if (x === undefined || y === undefined) return true;
  return (x !== 0 || y !== 0) && x % WHEEL_DELTA_PER_NOTCH === 0 && y % WHEEL_DELTA_PER_NOTCH === 0;
}

/** A wheel event's deltas in scrcpy scroll units: one notch is one unit, and scrolling down is negative. */
export function wheelToScroll(deltaX: number, deltaY: number, speed: number): { x: number; y: number } {
  return { x: (-deltaX / WHEEL_NOTCH_PX) * speed, y: (-deltaY / WHEEL_NOTCH_PX) * speed };
}

function sliceOf(pending: number, fraction: number): number {
  const size = Math.abs(pending);
  const slice = Math.min(Math.max(size * fraction, SMALLEST_SLICE), MAX_SCROLL_PER_MESSAGE);
  if (size - slice < SMALLEST_SLICE) return pending;
  return Math.sign(pending) * slice;
}

/**
 * Spreads each wheel notch over several frames instead of one jump: each
 * frame sends a share of what is still to come, easing out over roughly
 * `smoothingMs`.
 */
export class ScrollSmoother {
  #x = 0;
  #y = 0;

  get idle(): boolean {
    return this.#x === 0 && this.#y === 0;
  }

  add(x: number, y: number): void {
    this.#x = x * this.#x < 0 ? x : this.#x + x;
    this.#y = y * this.#y < 0 ? y : this.#y + y;
  }

  take(elapsedMs: number, smoothingMs: number): { x: number; y: number } {
    const fraction = smoothingMs > 0 ? 1 - Math.exp((-3 * elapsedMs) / smoothingMs) : 1;
    const x = sliceOf(this.#x, fraction);
    const y = sliceOf(this.#y, fraction);
    this.#x -= x;
    this.#y -= y;
    return { x, y };
  }

  clear(): void {
    this.#x = 0;
    this.#y = 0;
  }
}
