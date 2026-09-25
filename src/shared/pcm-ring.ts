/**
 * Pure PCM jitter-buffer policy, pulled straight into an AudioWorkletProcessor
 * (pcm-worklet.ts) with no other dependencies, so it can also be driven
 * directly in tests without any Web Audio API. Planar: one Float32Array per
 * channel, all channels the same length.
 *
 * Policy: buffer 40ms before starting playback; once playing, an underrun
 * (not enough buffered to satisfy a pull) outputs silence for the shortfall
 * and returns to buffering, requiring 40ms again before resuming; feeding
 * past 120ms buffered drops the oldest samples back down to the 40ms
 * target, since audio already handed to a real player can never be
 * un-queued, so this is the only lever against runaway latency.
 */
export class PcmRing {
  readonly #channels: number;
  readonly #targetFrames: number;
  readonly #maxFrames: number;
  #chunks: Float32Array[][] = [];
  #bufferedFrames = 0;
  #playing = false;

  constructor(sampleRate: number, channels: number, opts?: { targetMs?: number; maxMs?: number }) {
    this.#channels = channels;
    this.#targetFrames = Math.round(((opts?.targetMs ?? 40) / 1000) * sampleRate);
    this.#maxFrames = Math.round(((opts?.maxMs ?? 120) / 1000) * sampleRate);
  }

  get bufferedFrames(): number {
    return this.#bufferedFrames;
  }

  get playing(): boolean {
    return this.#playing;
  }

  /** planes: one Float32Array per channel, all the same length; ignored if empty. */
  push(planes: Float32Array[]): void {
    const frames = planes[0]?.length ?? 0;
    if (frames <= 0) return;
    this.#chunks.push(planes);
    this.#bufferedFrames += frames;
    if (this.#bufferedFrames > this.#maxFrames) {
      while (this.#chunks.length > 1 && this.#bufferedFrames > this.#targetFrames) {
        const dropped = this.#chunks.shift()!;
        this.#bufferedFrames -= dropped[0]?.length ?? 0;
      }
    }
  }

  /** Always returns frameCount frames per channel; silence while buffering or on underrun. */
  pull(frameCount: number): Float32Array[] {
    const out: Float32Array[] = [];
    for (let ch = 0; ch < this.#channels; ch++) out.push(new Float32Array(frameCount));
    if (frameCount <= 0) return out;

    if (!this.#playing) {
      if (this.#bufferedFrames >= this.#targetFrames) this.#playing = true;
      else return out;
    }

    let filled = 0;
    while (filled < frameCount && this.#chunks.length > 0) {
      const chunk = this.#chunks[0];
      const chunkFrames = chunk[0]?.length ?? 0;
      const take = Math.min(chunkFrames, frameCount - filled);
      for (let ch = 0; ch < this.#channels; ch++) {
        const src = chunk[ch];
        if (src) out[ch].set(src.subarray(0, take), filled);
      }
      if (take >= chunkFrames) {
        this.#chunks.shift();
      } else {
        for (let ch = 0; ch < this.#channels; ch++) {
          const src = chunk[ch];
          if (src) chunk[ch] = src.subarray(take);
        }
      }
      filled += take;
      this.#bufferedFrames -= take;
    }

    if (filled < frameCount) this.#playing = false;
    return out;
  }

  reset(): void {
    this.#chunks = [];
    this.#bufferedFrames = 0;
    this.#playing = false;
  }
}
