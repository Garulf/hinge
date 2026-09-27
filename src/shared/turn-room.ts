import { NO_PAD, type Pad } from "./layout";

const GIVE_BACK_AFTER_MS = 500;

function needsRoom(need: Pad): boolean {
  return need.x > 0 || need.y > 0;
}

/** need: how far the phone reaches past the work view's window now; straightOn: not turned. */
export interface TurnPose {
  need: Pad;
  straightOn: boolean;
}

/**
 * The room the window keeps around a turned phone. Growing the
 * window evenly moves its top left corner, and Windows shows the page's
 * last frame at the new corner for a refresh before the resized page
 * arrives, so every resize during a turn jolts the phone on screen. The room
 * is therefore taken all at once, as much as any turn could need, on the
 * first frame a turn needs any, held for as long as the phone is turned,
 * and given back once it has been straight on for a moment.
 */
export class TurnRoom {
  #held: Pad = NO_PAD;
  #straightSinceMs: number | null = null;

  /** reserve: the furthest past the work view's window any turn could reach. */
  update(pose: TurnPose, reserve: Pad, nowMs: number): Pad {
    const holding = needsRoom(this.#held);
    if (!holding && !needsRoom(pose.need)) return this.#held;
    if (!pose.straightOn || needsRoom(pose.need)) {
      this.#straightSinceMs = null;
      this.#held = { x: Math.max(pose.need.x, reserve.x), y: Math.max(pose.need.y, reserve.y) };
      return this.#held;
    }
    this.#straightSinceMs ??= nowMs;
    if (nowMs - this.#straightSinceMs >= GIVE_BACK_AFTER_MS) this.release();
    return this.#held;
  }

  release(): void {
    this.#held = NO_PAD;
    this.#straightSinceMs = null;
  }
}
