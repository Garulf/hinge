import type { FrameTarget } from "./texture-renderer";

/**
 * scrcpy's MOD+z: while paused the decoder keeps running but its frames are
 * dropped, so the screen holds the last one shown. The first frame of a new
 * stream size still goes through: after a fold the lit screen changes, and
 * holding the other screen's frame would show it stretched.
 */
export class PausableTarget implements FrameTarget {
  paused = false;
  readonly #target: FrameTarget;

  constructor(target: FrameTarget) {
    this.#target = target;
  }

  get disposed(): boolean {
    return this.#target.disposed;
  }

  setFrame(frame: VideoFrame, firstOfSize = false): void {
    if (this.paused && !firstOfSize) frame.close();
    else this.#target.setFrame(frame, firstOfSize);
  }

  end(): void {
    this.#target.end();
  }
}
