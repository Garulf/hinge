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
  read(frame: VideoFrame): Promise<Uint8ClampedArray>;
  now(): number;
  onChange(black: boolean): void;
  intervalMs?: number;
}

/**
 * A static screen sends no new frames, so the last reading stands until one
 * arrives. A frame skipped by the throttle, or offered while a read is still in
 * flight, is kept (cloned) and read when the window ends: the frame a screen
 * settles on is often the one skipped. The reader takes its own clone, so a
 * frame handed to it may be closed at once.
 */
export class BlackSampler {
  readonly #deps: BlackSamplerDeps;
  #black: boolean | null = null;
  #lastAt = -Infinity;
  #pending: VideoFrame | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #reading = false;
  #generation = 0;

  constructor(deps: BlackSamplerDeps) {
    this.#deps = deps;
  }

  offer(frame: VideoFrame): void {
    const wait = this.#reading ? Infinity : this.#wait();
    if (wait > 0) {
      this.#keep(frame, wait);
      return;
    }
    this.#dropPending();
    void this.#sample(frame);
  }

  /** The stream ended: the next frame is read at once and always reported. */
  reset(): void {
    this.#generation++;
    this.#reading = false;
    this.#dropPending();
    this.#black = null;
    this.#lastAt = -Infinity;
  }

  #wait(): number {
    return (this.#deps.intervalMs ?? INTERVAL_MS) - (this.#deps.now() - this.#lastAt);
  }

  #keep(frame: VideoFrame, wait: number): void {
    this.#pending?.close();
    this.#pending = null;
    try {
      this.#pending = frame.clone();
    } catch {
      return;
    }
    if (Number.isFinite(wait)) this.#timer ??= setTimeout(() => this.#readPending(), wait);
  }

  #readPending(): void {
    const frame = this.#pending;
    this.#pending = null;
    this.#timer = null;
    if (!frame) return;
    void this.#sample(frame);
    frame.close();
  }

  #dropPending(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending?.close();
    this.#pending = null;
  }

  async #sample(frame: VideoFrame): Promise<void> {
    const generation = this.#generation;
    this.#reading = true;
    this.#lastAt = this.#deps.now();
    let black: boolean | null = null;
    try {
      black = isBlack(await this.#deps.read(frame));
    } catch {
      black = null;
    }
    if (generation !== this.#generation) return;
    this.#reading = false;
    if (black !== null && black !== this.#black) {
      this.#black = black;
      this.#deps.onChange(black);
    }
    this.#schedulePending();
  }

  #schedulePending(): void {
    if (!this.#pending || this.#timer !== null) return;
    const wait = this.#wait();
    if (wait > 0) this.#timer = setTimeout(() => this.#readPending(), wait);
    else this.#readPending();
  }
}

/** A 16x16 point sample of an RGBA image, taken at the centre of each cell. */
export function gridSample(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let gy = 0; gy < SIZE; gy++) {
    const y = Math.floor(((gy + 0.5) * height) / SIZE);
    for (let gx = 0; gx < SIZE; gx++) {
      const x = Math.floor(((gx + 0.5) * width) / SIZE);
      const from = (y * width + x) * 4;
      out.set(rgba.subarray(from, from + 4), (gy * SIZE + gx) * 4);
    }
  }
  return out;
}

/** An async copy: getImageData is a synchronous GPU readback that stalls the renderer and decoding under software GL. */
export function frameReader(): (frame: VideoFrame) => Promise<Uint8ClampedArray> {
  let buffer = new Uint8Array(0);
  return async (frame) => {
    const clone = frame.clone();
    try {
      const options = { format: "RGBA" } as const;
      const size = clone.allocationSize(options);
      if (buffer.length !== size) buffer = new Uint8Array(size);
      await clone.copyTo(buffer, options);
      const { width, height } = clone.visibleRect ?? { width: clone.codedWidth, height: clone.codedHeight };
      return gridSample(buffer, width, height);
    } finally {
      clone.close();
    }
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
