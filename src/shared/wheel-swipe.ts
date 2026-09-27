import { AndroidFling } from "./android-fling";
import { classifyScreen, FOLD7 } from "./fold7";
import type { ControlIntent, TouchAction } from "./wire";

/** Both Fold 7 screens run at 420 dpi. */
export const FOLD7_DENSITY = 2.625;

/** Android's mouse scroll step: one wheel notch scrolls a view this far. */
const NOTCH_DP = 64;
const TOUCH_SLOP_DP = 8;
/**
 * The finger keeps moving this long after the last notch before it lifts.
 * It matches the 100 ms Android's VelocityTracker looks back over, so the
 * speed the phone measures at the lift is the steady one, not the press.
 */
const TAIL_MS = 100;
/** Frames that stall this long leave the finger resting, which a view could take for a long press. */
const STALL_MS = 250;
/** Keeps the finger out of the back, notification shade and home gesture areas at the screen edges. */
const EDGE_DP = { side: 48, top: 64, bottom: 64 };
/** A stroke starting closer than this to the edge it moves towards starts further in, so it has room to travel. */
const ROOM_DP = 160;

/** scrcpy's generic finger, unused by a plain mouse touch (which is the mouse pointer). */
const POINTER_FINGER = -2;

interface Vec {
  x: number;
  y: number;
}

interface Size {
  w: number;
  h: number;
}

interface Placement {
  stream: Size;
  /** Stream px per device px. */
  scale: number;
  origin: Vec;
}

interface Stroke extends Placement {
  finger: Vec;
  /** Content distance still to scroll, device px along the finger's travel; the fling after the lift counts towards it. */
  owed: Vec;
  /** A stroke that caught a running fling drags at once, with no touch slop, and cannot become a tap. */
  caught: boolean;
  lastNotchAt: number;
  lastFrameAt: number;
}

interface Release {
  at: number;
  velocity: Vec;
}

interface Restart extends Placement {
  owed: Vec;
}

/** Stream px per device px: 1 unless the stream is downscaled by a max size. */
function streamScale(stream: Size): number {
  const panel = FOLD7[classifyScreen(stream.w, stream.h, null).screen].px;
  return Math.max(stream.w, stream.h) / Math.max(panel.w, panel.h);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

function safeArea(placement: Placement, density: number): { left: number; right: number; top: number; bottom: number } {
  const w = placement.stream.w / placement.scale;
  const h = placement.stream.h / placement.scale;
  return { left: EDGE_DP.side * density, right: w - EDGE_DP.side * density, top: EDGE_DP.top * density, bottom: h - EDGE_DP.bottom * density };
}

/** Where on one axis a finger heading `direction` should go down: at `at`, unless that leaves it too little room ahead. */
function startOnAxis(at: number, direction: number, min: number, max: number, room: number): number {
  const inside = clamp(at, min, max);
  if (direction < 0) return clamp(Math.max(inside, min + room), min, max);
  if (direction > 0) return clamp(Math.min(inside, max - room), min, max);
  return inside;
}

function startPoint(placement: Placement, travel: Vec, density: number): Vec {
  const safe = safeArea(placement, density);
  const room = ROOM_DP * density;
  return {
    x: startOnAxis(placement.origin.x, travel.x, safe.left, safe.right, room),
    y: startOnAxis(placement.origin.y, travel.y, safe.top, safe.bottom, room),
  };
}

/**
 * Turns mouse wheel notches into finger swipes, so the phone scrolls the way
 * it does under a finger and finishes each swipe with its own fling. A burst
 * of notches is one stroke that keeps moving while notches arrive, then lets
 * go at the speed whose fling covers what is left: the phone animates that
 * part itself, so it stays smooth whatever the link's timing. A notch that
 * arrives while a fling runs catches it with a new stroke, as a finger would.
 */
export class WheelSwipe {
  readonly #fling: AndroidFling;
  readonly #density: number;
  #stroke: Stroke | null = null;
  #release: Release | null = null;
  #restart: Restart | null = null;

  constructor(density = FOLD7_DENSITY) {
    this.#density = density;
    this.#fling = new AndroidFling(density);
  }

  /** Whether frames are still needed: a finger is down or a stroke is about to start again. */
  get busy(): boolean {
    return this.#stroke !== null || this.#restart !== null;
  }

  /** The stream size a held finger was placed against, so a changed stream can cancel it. */
  get stream(): Size | null {
    return this.#stroke?.stream ?? null;
  }

  /**
   * A wheel notch in scrcpy scroll units (one unit is one notch; negative y
   * scrolls down, so the finger moves up) at a point on the stream, in
   * stream px.
   */
  add(units: Vec, at: Vec, stream: Size, now: number): ControlIntent[] {
    const notch = NOTCH_DP * this.#density;
    const delta = { x: units.x * notch, y: units.y * notch };
    const stroke = this.#stroke;
    if (stroke) {
      stroke.owed = { x: stroke.owed.x + delta.x, y: stroke.owed.y + delta.y };
      stroke.lastNotchAt = now;
      return [];
    }
    const carried = this.#restart?.owed ?? { x: 0, y: 0 };
    this.#restart = null;
    const scale = streamScale(stream);
    return this.#start({ stream, scale, origin: { x: at.x / scale, y: at.y / scale } }, { x: delta.x + carried.x, y: delta.y + carried.y }, now);
  }

  /** Moves a held finger on by one frame, lifting it once the notches stop. */
  frame(now: number): ControlIntent[] {
    const restart = this.#restart;
    if (restart) {
      this.#restart = null;
      return this.#start(restart, restart.owed, now);
    }
    const stroke = this.#stroke;
    if (!stroke) return [];
    // A frame's time can come before the wheel event's that started the stroke.
    const dt = Math.max(0, now - stroke.lastFrameAt);
    stroke.lastFrameAt = Math.max(now, stroke.lastFrameAt);
    if (dt > STALL_MS) return this.#lift("up", now, { x: 0, y: 0 });
    const left = TAIL_MS - (now - stroke.lastNotchAt);
    const horizon = (Math.max(left, 0) + dt) / 1000;
    const velocity = { x: this.#speedFor(stroke.owed.x, horizon), y: this.#speedFor(stroke.owed.y, horizon) };
    const wanted = { x: stroke.finger.x + (velocity.x * dt) / 1000, y: stroke.finger.y + (velocity.y * dt) / 1000 };
    const safe = safeArea(stroke, this.#density);
    const finger = { x: clamp(wanted.x, safe.left, safe.right), y: clamp(wanted.y, safe.top, safe.bottom) };
    stroke.owed = { x: stroke.owed.x - (finger.x - stroke.finger.x), y: stroke.owed.y - (finger.y - stroke.finger.y) };
    stroke.finger = finger;
    const move = this.#touch("move", stroke);
    const outOfRoom = finger.x !== wanted.x || finger.y !== wanted.y;
    if (left > 0 && !outOfRoom) return [move];
    return [move, ...this.#lift("up", now, velocity)];
  }

  /** Lets go without a fling, when the display pauses, focus goes or a real press needs the screen. */
  cancel(): ControlIntent[] {
    this.#restart = null;
    this.#release = null;
    if (!this.#stroke) return [];
    return this.#lift("cancel", 0, { x: 0, y: 0 });
  }

  #start(placement: Placement, delta: Vec, now: number): ControlIntent[] {
    const flingLeft = this.#flingLeft(now);
    const slop = flingLeft ? 0 : TOUCH_SLOP_DP * this.#density;
    const owed = {
      x: delta.x + (flingLeft ? flingLeft.x : Math.sign(delta.x) * slop),
      y: delta.y + (flingLeft ? flingLeft.y : Math.sign(delta.y) * slop),
    };
    this.#release = null;
    const origin = startPoint(placement, owed, this.#density);
    this.#stroke = { ...placement, origin, finger: origin, owed, caught: flingLeft !== null, lastNotchAt: now, lastFrameAt: now };
    return [this.#touch("down", this.#stroke)];
  }

  #lift(action: "up" | "cancel", now: number, velocity: Vec): ControlIntent[] {
    const stroke = this.#stroke;
    if (!stroke) return [];
    this.#stroke = null;
    const moved = Math.hypot(stroke.finger.x - stroke.origin.x, stroke.finger.y - stroke.origin.y);
    const couldTap = !stroke.caught && moved < TOUCH_SLOP_DP * this.#density * 1.5;
    const lift = this.#touch(action === "up" && couldTap ? "cancel" : action, stroke);
    if (action === "cancel" || couldTap) return [lift];
    this.#release = { at: now, velocity };
    const beyond = {
      x: stroke.owed.x - Math.sign(velocity.x) * this.#fling.distance(velocity.x),
      y: stroke.owed.y - Math.sign(velocity.y) * this.#fling.distance(velocity.y),
    };
    const notch = NOTCH_DP * this.#density;
    if (Math.hypot(beyond.x, beyond.y) > notch / 4) this.#restart = { stream: stroke.stream, scale: stroke.scale, origin: stroke.origin, owed: beyond };
    return [lift];
  }

  /** What a fling still running from the last lift has left to go, per axis, or null once it has stopped. */
  #flingLeft(now: number): Vec | null {
    const release = this.#release;
    if (!release) return null;
    const elapsed = Math.max(0, now - release.at);
    const x = this.#fling.at(Math.abs(release.velocity.x), elapsed);
    const y = this.#fling.at(Math.abs(release.velocity.y), elapsed);
    const min = this.#fling.minVelocity;
    if (x.velocity < min && y.velocity < min) return null;
    return {
      x: Math.sign(release.velocity.x) * (this.#fling.distance(release.velocity.x) - x.travelled),
      y: Math.sign(release.velocity.y) * (this.#fling.distance(release.velocity.y) - y.travelled),
    };
  }

  /** The finger speed, px/s signed, that covers `owed` with `horizon` seconds of travel and the fling after it. */
  #speedFor(owed: number, horizon: number): number {
    const distance = Math.abs(owed);
    if (distance < 0.5) return 0;
    let lo = 0;
    let hi = this.#fling.maxVelocity;
    if (hi * horizon + this.#fling.distance(hi) <= distance) return Math.sign(owed) * hi;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (mid * horizon + this.#fling.distance(mid) > distance) hi = mid;
      else lo = mid;
    }
    return Math.sign(owed) * lo;
  }

  #touch(action: TouchAction, stroke: Stroke): ControlIntent {
    const released = action === "up" || action === "cancel";
    const { w, h } = stroke.stream;
    return {
      type: "touch",
      action,
      pointerId: POINTER_FINGER,
      x: clamp(Math.round(stroke.finger.x * stroke.scale), 0, w - 1),
      y: clamp(Math.round(stroke.finger.y * stroke.scale), 0, h - 1),
      videoWidth: w,
      videoHeight: h,
      pressure: released ? 0 : 1,
      buttons: 0,
    };
  }
}
