import { NO_PAD, type Pad } from "./layout";

const GIVE_BACK_AFTER_MS = 500;

function needsRoom(need: Pad): boolean {
  return need.x > 0 || need.y > 0;
}

/**
 * The room the window keeps around a turned (or orbited) phone. Growing the
 * window evenly moves its top left corner, and Windows shows the page's
 * last frame at the new corner for a refresh before the resized page
 * arrives, so every resize during a turn jolts the phone on screen. The room
 * is therefore taken all at once, as much as any turn could need, on the
 * first frame a turn needs any, held while the phone turns, and given back
 * only once the phone has fitted the work view's window for a while.
 */
export class TurnRoom {
  #held: Pad = NO_PAD;
  #fitSinceMs: number | null = null;

  /** need: how far the phone reaches past the work view's window now; reserve: the furthest any turn could reach. */
  update(need: Pad, reserve: Pad, nowMs: number): Pad {
    if (needsRoom(need)) {
      this.#fitSinceMs = null;
      this.#held = { x: Math.max(need.x, reserve.x), y: Math.max(need.y, reserve.y) };
    } else if (needsRoom(this.#held)) {
      this.#fitSinceMs ??= nowMs;
      if (nowMs - this.#fitSinceMs >= GIVE_BACK_AFTER_MS) this.release();
    }
    return this.#held;
  }

  release(): void {
    this.#held = NO_PAD;
    this.#fitSinceMs = null;
  }
}
