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
export const MODEL_LIMITS: ModelAngles = { yaw: 75, pitch: 60 };

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

export function clampModelAngles(angles: ModelAngles): ModelAngles {
  return { yaw: clamp(angles.yaw, MODEL_LIMITS.yaw), pitch: clamp(angles.pitch, MODEL_LIMITS.pitch) };
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
 * An Alt+left press: the angle follows the pointer's offset from the press
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

  /** A press that is not an Alt press came between: the next Alt click starts a new pair. */
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

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The box of the unturned pose, in world units. */
export interface FitBox {
  min: Vec3;
  max: Vec3;
}

/** What the orthographic camera sees, in world units. */
export interface FitFrame {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** A point turned about the origin as the scene turns the model: yaw about Y, then -pitch about X. */
export function turnPoint(p: Vec3, angles: ModelAngles): Vec3 {
  const yaw = rad(angles.yaw);
  const tilt = rad(-angles.pitch);
  const x = p.x * Math.cos(yaw) + p.z * Math.sin(yaw);
  const z = -p.x * Math.sin(yaw) + p.z * Math.cos(yaw);
  return { x, y: p.y * Math.cos(tilt) - z * Math.sin(tilt), z: p.y * Math.sin(tilt) + z * Math.cos(tilt) };
}

/**
 * The uniform scale, at most 1, that keeps the box's corners turned about
 * its centre within reach on every side: each side may reach as far from
 * the centre as the unturned box does, or the frame, whichever is further.
 * Exactly 1 at rest, and it tends to 1 as the angles go to 0.
 */
export function turnFitScale(box: FitBox, frame: FitFrame, angles: ModelAngles): number {
  if (angles.yaw === 0 && angles.pitch === 0) return 1;
  const c = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 };
  const allowed = {
    right: Math.max(box.max.x - c.x, frame.maxX - c.x),
    left: Math.max(c.x - box.min.x, c.x - frame.minX),
    top: Math.max(box.max.y - c.y, frame.maxY - c.y),
    bottom: Math.max(c.y - box.min.y, c.y - frame.minY),
  };
  const reach = { right: 0, left: 0, top: 0, bottom: 0 };
  for (let i = 0; i < 8; i++) {
    const corner = {
      x: (i & 1 ? box.max.x : box.min.x) - c.x,
      y: (i & 2 ? box.max.y : box.min.y) - c.y,
      z: (i & 4 ? box.max.z : box.min.z) - c.z,
    };
    const q = turnPoint(corner, angles);
    reach.right = Math.max(reach.right, q.x);
    reach.left = Math.max(reach.left, -q.x);
    reach.top = Math.max(reach.top, q.y);
    reach.bottom = Math.max(reach.bottom, -q.y);
  }
  let scale = 1;
  for (const side of ["right", "left", "top", "bottom"] as const) {
    if (reach[side] > allowed[side]) scale = Math.min(scale, allowed[side] / reach[side]);
  }
  return scale;
}
