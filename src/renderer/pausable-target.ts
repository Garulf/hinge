import type { FrameTarget } from "./texture-renderer";

/** scrcpy's MOD+z: while paused the decoder keeps running but its frames are dropped, so the screen holds the last one shown. */
export class PausableTarget implements FrameTarget {
  paused = false;
  readonly #target: FrameTarget;

  constructor(target: FrameTarget) {
    this.#target = target;
  }

  get disposed(): boolean {
    return this.#target.disposed;
  }

  setFrame(frame: VideoFrame): void {
    if (this.paused) frame.close();
    else this.#target.setFrame(frame);
  }

  end(): void {
    this.#target.end();
  }
}
