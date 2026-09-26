import { Spring } from "./spring";

/** The user's turn of the phone model about its centre, in degrees: yaw about the screen's vertical axis, pitch tilting the top away. */
export interface ModelAngles {
  yaw: number;
  pitch: number;
}

export interface Point {
  x: number;
  y: number;
}

export const MODEL_REST: ModelAngles = { yaw: 0, pitch: 0 };
/** The one remaining limit: the turn is a full 360 degree turntable in yaw, but still tips at most this far in pitch. */
export const PITCH_LIMIT_DEG = 60;

/** How far off straight on the phone has to face for the full showcase look. */
export const FULL_LOOK_DEG = 30;

const DEG_PER_PX = 0.3;
const CLICK_SLOP_PX = 6;
const DOUBLE_CLICK_MS = 400;

/**
 * Spring.settleMs is calibrated against a 180 degree step; 470 brings a
 * 30 to 75 degree swing within half a degree of rest in 370 to 430 ms.
 */
const RESET_SETTLE_MS = 470;
const REST_EPSILON_DEG = 0.01;

function clamp(n: number, limit: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(n, -limit), limit) : 0;
}

/**
 * Wraps a yaw of any size into (-180, 180], the same orientation it always
 * was: 170 + 30 lands on -160, not 200, so a drag that carries the turn past
 * 180 never jumps and the reset spring (a plain interpolation to 0) always
 * takes the short way home.
 */
function wrapYaw(n: number): number {
  if (!Number.isFinite(n)) return 0;
  let wrapped = n % 360;
  if (wrapped > 180) wrapped -= 360;
  else if (wrapped <= -180) wrapped += 360;
  return wrapped;
}

export function clampModelAngles(angles: ModelAngles): ModelAngles {
  return { yaw: wrapYaw(angles.yaw), pitch: clamp(angles.pitch, PITCH_LIMIT_DEG) };
}

/** The angle between the turned phone's screen normal and the view axis, 0 to 180 degrees. */
export function offAxisDeg(angles: ModelAngles): number {
  const rad = Math.PI / 180;
  const [yaw, pitch] = [angles.yaw * rad, angles.pitch * rad];
  const across = Math.hypot(Math.sin(yaw), Math.cos(yaw) * Math.sin(pitch));
  return Math.atan2(across, Math.cos(yaw) * Math.cos(pitch)) / rad;
}

/**
 * How far the look has gone from the flat work view (0) to the showcase (1)
 * for a turn: exactly 0 straight on, so the work view there is untouched,
 * and easing in with no slope, so the first pixels of a turn barely change
 * the lens.
 */
export function turnBlend(angles: ModelAngles): number {
  const p = Math.min(1, offAxisDeg(angles) / FULL_LOOK_DEG);
  return p * p * (3 - 2 * p);
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

interface Press {
  point: Point;
  from: ModelAngles;
  atMs: number;
  moved: boolean;
}

/**
 * A turn press (Alt+left anywhere, or left on the case's sides and corners): the angle follows the pointer's offset from the press
 * point directly (no inertia), and two clicks that stay put within 400 ms
 * are a double click.
 */
export class RotateGesture {
  #press: Press | null = null;
  #lastClick: { point: Point; atMs: number } | null = null;

  press(point: Point, from: ModelAngles, nowMs: number): void {
    this.#press = { point, from, atMs: nowMs, moved: false };
  }

  /** The angle for the pointer at `point`, or null when no press is in progress. */
  move(point: Point): ModelAngles | null {
    const press = this.#press;
    if (!press) return null;
    this.#track(press, point);
    return clampModelAngles({
      yaw: press.from.yaw + (point.x - press.point.x) * DEG_PER_PX,
      pitch: press.from.pitch - (point.y - press.point.y) * DEG_PER_PX,
    });
  }

  /** "reset" when this release completes a double click; the angle stays where it is either way. */
  release(point: Point, nowMs: number): "keep" | "reset" {
    const press = this.#press;
    this.#press = null;
    if (!press) return "keep";
    this.#track(press, point);
    if (press.moved) {
      this.#lastClick = null;
      return "keep";
    }
    const first = this.#lastClick;
    if (first && press.atMs - first.atMs <= DOUBLE_CLICK_MS && distance(press.point, first.point) <= CLICK_SLOP_PX) {
      this.#lastClick = null;
      return "reset";
    }
    this.#lastClick = { point: press.point, atMs: press.atMs };
    return "keep";
  }

  cancel(): void {
    this.#press = null;
    this.#lastClick = null;
  }

  /** A press that is not a turn press came between: the next click starts a new pair. */
  otherPress(): void {
    this.#lastClick = null;
  }

  #track(press: Press, point: Point): void {
    if (distance(point, press.point) > CLICK_SLOP_PX) press.moved = true;
  }
}

/** The model's current turn: set directly while dragging, or springing back to rest after a reset. */
export class ModelRotation {
  readonly #yaw = new Spring({ value: 0, settleMs: RESET_SETTLE_MS });
  readonly #pitch = new Spring({ value: 0, settleMs: RESET_SETTLE_MS });
  #springing = false;

  get angles(): ModelAngles {
    return { yaw: this.#yaw.value, pitch: this.#pitch.value };
  }

  get moving(): boolean {
    return this.#springing;
  }

  set(angles: ModelAngles): void {
    const { yaw, pitch } = clampModelAngles(angles);
    this.#place(this.#yaw, yaw);
    this.#place(this.#pitch, pitch);
    this.#springing = false;
  }

  reset(): void {
    this.#yaw.target = MODEL_REST.yaw;
    this.#pitch.target = MODEL_REST.pitch;
    this.#springing = this.#yaw.value !== MODEL_REST.yaw || this.#pitch.value !== MODEL_REST.pitch;
  }

  tick(dtMs: number): ModelAngles {
    if (this.#springing) {
      for (const spring of [this.#yaw, this.#pitch]) {
        spring.step(dtMs);
        spring.snapIfSettled(REST_EPSILON_DEG);
      }
      this.#springing = this.#yaw.value !== this.#yaw.target || this.#pitch.value !== this.#pitch.target;
    }
    return this.angles;
  }

  #place(spring: Spring, value: number): void {
    spring.value = value;
    spring.target = value;
    spring.velocity = 0;
  }
}
