const SECOND_ERROR_WINDOW_MS = 5000;

/** A decode error first asks the device to restart its encoder; only a second error soon after is worth showing. */
export class DecodeRecovery {
  #lastResetMs = -Infinity;

  onError(nowMs: number): "reset" | "show" {
    if (nowMs - this.#lastResetMs <= SECOND_ERROR_WINDOW_MS) return "show";
    this.#lastResetMs = nowMs;
    return "reset";
  }
}
