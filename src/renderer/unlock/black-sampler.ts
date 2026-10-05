import type { FrameTarget } from "../texture-renderer";

const SIZE = 16;
const DARK = 24;
/** Black even with the status bar and navigation pill, which are not secure layers, drawn over a black keyguard. */
const BLACK_SHARE = 0.9;
const INTERVAL_MS = 500;

export function isBlack(rgba: Uint8ClampedArray): boolean {
  const samples = rgba.length / 4;
  let dark = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) <= DARK) dark++;
  }
  return dark >= samples * BLACK_SHARE;
}

export interface BlackSamplerDeps {
  read(frame: VideoFrame): Uint8ClampedArray;
  now(): number;
  onChange(black: boolean): void;
  intervalMs?: number;
}

/**
 * A static screen sends no new frames, so the last reading stands until one
 * arrives. A frame skipped by the throttle is kept (cloned) and read when the
 * window ends: the frame a screen settles on is often the one skipped.
 */
export class BlackSampler {
  readonly #deps: BlackSamplerDeps;
  #black: boolean | null = null;
  #lastAt = -Infinity;
  #pending: VideoFrame | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: BlackSamplerDeps) {
    this.#deps = deps;
  }

  offer(frame: VideoFrame): void {
    const wait = this.#interval() - (this.#deps.now() - this.#lastAt);
    if (wait > 0) {
      this.#keep(frame, wait);
      return;
    }
    this.#dropPending();
    this.#sample(frame);
  }

  /** The stream ended: the next frame is read at once and always reported. */
  reset(): void {
    this.#dropPending();
    this.#black = null;
    this.#lastAt = -Infinity;
  }

  #interval(): number {
    return this.#deps.intervalMs ?? INTERVAL_MS;
  }

  #keep(frame: VideoFrame, wait: number): void {
    this.#pending?.close();
    this.#pending = null;
    try {
      this.#pending = frame.clone();
    } catch {
      return;
    }
    this.#timer ??= setTimeout(() => this.#readPending(), wait);
  }

  #readPending(): void {
    const frame = this.#pending;
    this.#pending = null;
    this.#timer = null;
    if (!frame) return;
    this.#sample(frame);
    frame.close();
  }

  #dropPending(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending?.close();
    this.#pending = null;
  }

  #sample(frame: VideoFrame): void {
    this.#lastAt = this.#deps.now();
    let black: boolean;
    try {
      black = isBlack(this.#deps.read(frame));
    } catch {
      return;
    }
    if (black === this.#black) return;
    this.#black = black;
    this.#deps.onChange(black);
  }
}

export function canvasReader(): (frame: VideoFrame) => Uint8ClampedArray {
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");
  return (frame) => {
    ctx.drawImage(frame, 0, 0, SIZE, SIZE);
    return ctx.getImageData(0, 0, SIZE, SIZE).data;
  };
}

/** Samples each decoded frame on its way to the screen, before a pause can drop it. */
export class SamplingTarget implements FrameTarget {
  readonly #target: FrameTarget;
  readonly #sampler: Pick<BlackSampler, "offer">;

  constructor(target: FrameTarget, sampler: Pick<BlackSampler, "offer">) {
    this.#target = target;
    this.#sampler = sampler;
  }

  get disposed(): boolean {
    return this.#target.disposed;
  }

  setFrame(frame: VideoFrame, firstOfSize = false): void {
    this.#sampler.offer(frame);
    this.#target.setFrame(frame, firstOfSize);
  }

  end(): void {
    this.#target.end();
  }
}
