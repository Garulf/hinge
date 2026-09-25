const MAX_SUBSTEP_MS = 4;

/**
 * omega*settleMs solves (1+k)e^-k = 0.5/180, the relative accuracy a 180
 * degree step needs to land within 0.5 degrees of target at t = settleMs
 * for a critically damped step response.
 */
const SETTLE_K = 8.093684155121819;

/** A critically damped spring, integrated with semi-implicit Euler in sub-steps of at most 4 ms. */
export class Spring {
  target: number;
  value: number;
  velocity = 0;
  #omega: number;

  constructor(opts: { value: number; settleMs: number }) {
    this.value = opts.value;
    this.target = opts.value;
    this.#omega = SETTLE_K / opts.settleMs;
  }

  step(dtMs: number): void {
    let remaining = dtMs;
    while (remaining > 0) {
      const h = Math.min(MAX_SUBSTEP_MS, remaining);
      const acceleration = this.#omega * this.#omega * (this.target - this.value) - 2 * this.#omega * this.velocity;
      this.velocity += acceleration * h;
      this.value += this.velocity * h;
      remaining -= h;
    }
  }

  /**
   * epsilon * omega is the velocity below which, at this spring's own decay
   * rate, position would move less than epsilon before it mattered again:
   * scaling by omega (rather than a flat velocity bound) keeps this already
   * satisfied by the time the 180 degree reference step reaches its position
   * tolerance, so it rejects a spring merely passing through target without
   * pushing settling later than the design's 450 ms plus or minus 50 window.
   */
  settled(epsilon = 0.5): boolean {
    return Math.abs(this.target - this.value) <= epsilon && Math.abs(this.velocity) <= epsilon * this.#omega;
  }

  /** Lands exactly on target once settled, so a finished move rests on the exact pose instead of creeping toward it. */
  snapIfSettled(): void {
    if (!this.settled()) return;
    this.value = this.target;
    this.velocity = 0;
  }
}
