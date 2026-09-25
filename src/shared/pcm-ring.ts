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
 *
 * pullInto() is the hot path, called once per render quantum (every ~3ms)
 * on the audio thread: it writes into the caller's own output buffers and
 * tracks a read offset into the head chunk instead of slicing, so it never
 * allocates. Dropping on overflow also works by offset, landing the buffer
 * at exactly the 40ms target rather than whichever whole chunk boundary
 * happens to fall under it.
 */
interface Chunk {
  planes: Float32Array[];
  /** Read offset into each plane; frames before this index are already consumed. */
  offset: number;
  /** Frames remaining in this chunk from offset. */
  frames: number;
}

export class PcmRing {
  readonly #channels: number;
  readonly #targetFrames: number;
  readonly #maxFrames: number;
  #chunks: Chunk[] = [];
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
    this.#chunks.push({ planes, offset: 0, frames });
    this.#bufferedFrames += frames;
    if (this.#bufferedFrames > this.#maxFrames) {
      // Land exactly at the target, not at whichever chunk boundary happens
      // to fall under it: drop precisely the excess by samples, splitting
      // the chunk mid-way via its offset if needed, rather than dropping
      // only whole chunks (which could overshoot and leave the buffer
      // under 40ms).
      this.#dropFrames(this.#bufferedFrames - this.#targetFrames);
    }
  }

  #dropFrames(count: number): void {
    let remaining = count;
    while (remaining > 0 && this.#chunks.length > 0) {
      const chunk = this.#chunks[0]!;
      const take = Math.min(chunk.frames, remaining);
      chunk.offset += take;
      chunk.frames -= take;
      this.#bufferedFrames -= take;
      remaining -= take;
      if (chunk.frames <= 0) this.#chunks.shift();
    }
  }

  /**
   * Fills every channel in `outputs` (one Float32Array per channel, all the
   * same length) with the next frames, silence while buffering or on
   * underrun. Allocates nothing: writes sample-by-sample into the caller's
   * own buffers and advances an offset into the head chunk instead of
   * slicing it. Returns the number of frames filled with real audio (the
   * rest, if any, is silence).
   */
  pullInto(outputs: Float32Array[]): number {
    const frameCount = outputs[0]?.length ?? 0;
    if (frameCount <= 0) return 0;

    if (!this.#playing) {
      if (this.#bufferedFrames >= this.#targetFrames) this.#playing = true;
      else {
        this.#silence(outputs, 0, frameCount);
        return 0;
      }
    }

    let filled = 0;
    while (filled < frameCount && this.#chunks.length > 0) {
      const chunk = this.#chunks[0]!;
      const take = Math.min(chunk.frames, frameCount - filled);
      for (let ch = 0; ch < outputs.length; ch++) {
        const src = chunk.planes[Math.min(ch, chunk.planes.length - 1)];
        const dst = outputs[ch];
        if (!src || !dst) continue;
        for (let i = 0; i < take; i++) dst[filled + i] = src[chunk.offset + i]!;
      }
      chunk.offset += take;
      chunk.frames -= take;
      if (chunk.frames <= 0) this.#chunks.shift();
      filled += take;
      this.#bufferedFrames -= take;
    }

    if (filled < frameCount) {
      this.#silence(outputs, filled, frameCount - filled);
      this.#playing = false;
    }
    return filled;
  }

  #silence(outputs: Float32Array[], start: number, length: number): void {
    for (const out of outputs) out?.fill(0, start, start + length);
  }

  reset(): void {
    this.#chunks = [];
    this.#bufferedFrames = 0;
    this.#playing = false;
  }
}
