import { WritableStream } from "@yume-chan/stream-extra";
import type { VideoFrameRenderer } from "@yume-chan/scrcpy-decoder-webcodecs";

/**
 * Owns decoded frames handed to it via setFrame(): a target must not close
 * one until it has actually been uploaded to the GPU (see PhoneScene /
 * FrameLifecycle), which TextureFrameRenderer itself has no way to know.
 * end() is called once the stream closes or aborts, so the target can
 * finish with whatever frame is still current.
 */
export interface FrameTarget {
  /** firstOfSize: the first decoded frame at a new stream size (after a start or a fold). */
  setFrame(frame: VideoFrame, firstOfSize?: boolean): void;
  end(): void;
  disposed: boolean;
}

export class TextureFrameRenderer implements VideoFrameRenderer {
  readonly type = "hardware" as const;
  readonly writable: WritableStream<VideoFrame>;
  framesRendered = 0;

  #target: FrameTarget;

  constructor(target: FrameTarget) {
    this.#target = target;
    this.writable = new WritableStream<VideoFrame>({
      write: (frame) => this.#write(frame),
      close: () => this.#target.end(),
      abort: () => this.#target.end(),
    });
  }

  #write(frame: VideoFrame): void {
    if (this.#target.disposed) {
      frame.close();
      return;
    }
    this.#target.setFrame(frame);
    this.framesRendered += 1;
  }
}
