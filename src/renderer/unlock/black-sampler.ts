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

/** A static screen sends no new frames, so the last reading stands until one arrives. */
export class BlackSampler {
  readonly #deps: BlackSamplerDeps;
  #black: boolean | null = null;
  #lastAt = -Infinity;

  constructor(deps: BlackSamplerDeps) {
    this.#deps = deps;
  }

  offer(frame: VideoFrame): void {
    const now = this.#deps.now();
    if (now - this.#lastAt < (this.#deps.intervalMs ?? INTERVAL_MS)) return;
    this.#lastAt = now;
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

  /** The stream ended: the next frame is read at once and always reported. */
  reset(): void {
    this.#black = null;
    this.#lastAt = -Infinity;
  }
}

export function canvasReader(): (frame: VideoFrame) => Uint8ClampedArray {
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
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
