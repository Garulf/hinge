/**
 * Android's fling curve (OverScroller's spline, which Compose's
 * FlingCalculator copies), so a synthesized swipe can be let go at the speed
 * whose fling the phone finishes at a known distance.
 */

const INFLEXION = 0.35;
const START_TENSION = 0.5;
const END_TENSION = 1;
const P1 = START_TENSION * INFLEXION;
const P2 = 1 - END_TENSION * (1 - INFLEXION);
const DECELERATION_RATE = Math.log(0.78) / Math.log(0.9);
const SCROLL_FRICTION = 0.015;
const GRAVITY_EARTH = 9.80665;
const INCHES_PER_METER = 39.37;
const SAMPLES = 100;

function splinePositions(): number[] {
  const positions: number[] = [];
  let xMin = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const alpha = i / SAMPLES;
    let xMax = 1;
    let x: number;
    let coef: number;
    for (;;) {
      x = xMin + (xMax - xMin) / 2;
      coef = 3 * x * (1 - x);
      const tx = coef * ((1 - x) * P1 + x * P2) + x * x * x;
      if (Math.abs(tx - alpha) < 1e-5) break;
      if (tx > alpha) xMax = x;
      else xMin = x;
    }
    positions.push(coef * ((1 - x) * START_TENSION + x) + x * x * x);
  }
  positions.push(1);
  return positions;
}

const SPLINE = splinePositions();

export interface FlingState {
  /** How far the fling has gone, px. */
  travelled: number;
  /** Its speed now, px/s. */
  velocity: number;
}

export class AndroidFling {
  /** friction times Android's physical coefficient, in px. */
  readonly #reach: number;
  readonly #maxVelocity: number;
  readonly #minVelocity: number;

  /** `density` is the phone's px per dp (2.625 at 420 dpi). */
  constructor(density: number) {
    const ppi = density * 160;
    this.#reach = SCROLL_FRICTION * GRAVITY_EARTH * INCHES_PER_METER * ppi * 0.84;
    this.#maxVelocity = 8000 * density;
    this.#minVelocity = 50 * density;
  }

  get maxVelocity(): number {
    return this.#maxVelocity;
  }

  /** Below this, a lifted finger stops the content dead instead of flinging it. */
  get minVelocity(): number {
    return this.#minVelocity;
  }

  #deceleration(velocity: number): number {
    return Math.log((INFLEXION * Math.abs(velocity)) / this.#reach);
  }

  distance(velocity: number): number {
    if (Math.abs(velocity) < this.#minVelocity) return 0;
    return this.#reach * Math.exp((DECELERATION_RATE / (DECELERATION_RATE - 1)) * this.#deceleration(velocity));
  }

  durationMs(velocity: number): number {
    if (Math.abs(velocity) < this.#minVelocity) return 0;
    return 1000 * Math.exp(this.#deceleration(velocity) / (DECELERATION_RATE - 1));
  }

  /** The speed whose fling covers `distance` px. */
  velocityFor(distance: number): number {
    if (distance <= 0) return 0;
    const l = Math.log(distance / this.#reach) * ((DECELERATION_RATE - 1) / DECELERATION_RATE);
    return (this.#reach / INFLEXION) * Math.exp(l);
  }

  /** Where a fling started at `velocity` (px/s, positive) is `elapsedMs` later. */
  at(velocity: number, elapsedMs: number): FlingState {
    const duration = this.durationMs(velocity);
    const distance = this.distance(velocity);
    if (elapsedMs <= 0) return { travelled: 0, velocity: duration > 0 ? velocity : 0 };
    if (elapsedMs >= duration) return { travelled: distance, velocity: 0 };
    const t = elapsedMs / duration;
    const index = Math.floor(SAMPLES * t);
    const t0 = index / SAMPLES;
    const slope = (SPLINE[index + 1] - SPLINE[index]) * SAMPLES;
    const fraction = SPLINE[index] + (t - t0) * slope;
    return { travelled: fraction * distance, velocity: ((slope * distance) / duration) * 1000 };
  }
}
