import { Spring } from "./spring";

const DEG_PER_PX = 0.3;
const HOLD_MS = 2000;
const SETTLE_MS = 550;

function clamp(n: number, [min, max]: [number, number]): number {
  return Math.min(Math.max(n, min), max);
}

/** Yaw/pitch orbit offsets: dragging moves them, releasing holds for 2 s then springs back to rest. */
export class Orbit {
  readonly #rest: { yaw: number; pitch: number };
  readonly #limits: { yaw: [number, number]; pitch: [number, number] };
  readonly #yaw: Spring;
  readonly #pitch: Spring;
  #dragging = false;
  #releasedAtMs: number | null = null;

  constructor(rest: { yaw: number; pitch: number }, limits: { yaw: [number, number]; pitch: [number, number] }) {
    this.#rest = rest;
    this.#limits = limits;
    this.#yaw = new Spring({ value: rest.yaw, settleMs: SETTLE_MS });
    this.#pitch = new Spring({ value: rest.pitch, settleMs: SETTLE_MS });
  }

  drag(dxPx: number, dyPx: number): void {
    this.#dragging = true;
    this.#releasedAtMs = null;
    this.#move(this.#yaw, dxPx, this.#limits.yaw);
    this.#move(this.#pitch, dyPx, this.#limits.pitch);
  }

  release(nowMs: number): void {
    this.#dragging = false;
    this.#releasedAtMs = nowMs;
  }

  tick(nowMs: number, dtMs: number): { yaw: number; pitch: number } {
    const holdElapsed = !this.#dragging && this.#releasedAtMs !== null && nowMs - this.#releasedAtMs >= HOLD_MS;
    if (holdElapsed) {
      this.#yaw.target = this.#rest.yaw;
      this.#pitch.target = this.#rest.pitch;
      this.#yaw.step(dtMs);
      this.#pitch.step(dtMs);
    }
    return { yaw: this.#yaw.value, pitch: this.#pitch.value };
  }

  #move(spring: Spring, deltaPx: number, limits: [number, number]): void {
    const value = clamp(spring.value + deltaPx * DEG_PER_PX, limits);
    spring.value = value;
    spring.target = value;
    spring.velocity = 0;
  }
}
