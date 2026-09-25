import { WritableStream } from "@yume-chan/stream-extra";
import type { VideoFrameRenderer } from "@yume-chan/scrcpy-decoder-webcodecs";

export interface FrameTarget {
  setFrame(frame: VideoFrame): void;
  disposed: boolean;
}

export class TextureFrameRenderer implements VideoFrameRenderer {
  readonly type = "hardware" as const;
  readonly writable: WritableStream<VideoFrame>;
  framesRendered = 0;

  #target: FrameTarget;
  #held: VideoFrame | null = null;

  constructor(target: FrameTarget) {
    this.#target = target;
    this.writable = new WritableStream<VideoFrame>({
      write: (frame) => this.#write(frame),
      close: () => this.#closeHeld(),
      abort: () => this.#closeHeld(),
    });
  }

  #write(frame: VideoFrame): void {
    if (this.#target.disposed) {
      frame.close();
      return;
    }
    const previous = this.#held;
    this.#held = frame;
    this.#target.setFrame(frame);
    this.framesRendered += 1;
    previous?.close();
  }

  #closeHeld(): void {
    this.#held?.close();
    this.#held = null;
  }
}
