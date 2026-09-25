import type { AudioStreamInfo, WireAudioPacket } from "../shared/wire";

/** Structurally matches WebCodecs' AudioData, narrowed to what this module uses. */
export interface DecodedAudioLike {
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  copyTo(destination: Float32Array, options: { planeIndex: number; format: "f32-planar" }): void;
  close(): void;
}

export interface AudioDecoderHandle {
  decode(chunk: { timestamp: number; data: Uint8Array }): void;
  close(): void;
}

export type AudioDecoderFactory = (options: {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  output: (data: DecodedAudioLike) => void;
  error: (e: Error) => void;
}) => AudioDecoderHandle;

function defaultAudioDecoderFactory(options: {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  output: (data: DecodedAudioLike) => void;
  error: (e: Error) => void;
}): AudioDecoderHandle {
  const decoder = new AudioDecoder({
    output: (data) => options.output(data),
    error: (e) => options.error(e instanceof Error ? e : new Error(String(e))),
  });
  decoder.configure({ codec: options.codec, sampleRate: options.sampleRate, numberOfChannels: options.numberOfChannels });
  return {
    decode: (chunk) => decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: chunk.timestamp, data: chunk.data })),
    close: () => decoder.close(),
  };
}

/**
 * The post-decode PCM sink. No production default is provided here: the real
 * one (`@yume-chan/pcm-player`) is not an installed dependency in this
 * worktree, so wiring it lives entirely in its own adapter file
 * (audio-player-adapter.ts) behind this interface, kept out of AudioPipe so
 * this module never has to know the package exists.
 */
export interface PcmPlayerLike {
  start(): Promise<void>;
  feed(planes: Float32Array[]): void;
  stop(): void;
}

export type PcmPlayerFactory = (sampleRate: number, channelCount: number) => PcmPlayerLike;

export interface AudioPipeDeps {
  createPlayer: PcmPlayerFactory;
  createDecoder?: AudioDecoderFactory;
  now?: () => number;
  /** Fired at most once per stream: decode failure or player start failure both turn audio off for the rest of the session. */
  onError?: (message: string) => void;
}

const TARGET_LATENCY_MS = 40;
const MAX_BUFFER_MS = 120;

export class AudioPipe {
  readonly #createDecoder: AudioDecoderFactory;
  readonly #createPlayer: PcmPlayerFactory;
  readonly #now: () => number;
  readonly #onError: (message: string) => void;

  #decoder: AudioDecoderHandle | null = null;
  #player: PcmPlayerLike | null = null;
  #failed = false;
  #playStartMs: number | null = null;
  #firedMs = 0;

  constructor(deps: AudioPipeDeps) {
    this.#createDecoder = deps.createDecoder ?? defaultAudioDecoderFactory;
    this.#createPlayer = deps.createPlayer;
    this.#now = deps.now ?? (() => performance.now());
    this.#onError = deps.onError ?? (() => {});
  }

  start(info: AudioStreamInfo): void {
    this.#teardown();
    this.#failed = false;
    this.#playStartMs = null;
    this.#firedMs = 0;

    const player = this.#createPlayer(info.sampleRate, info.channels);
    this.#player = player;
    void player.start().catch((e) => this.#fail(`audio playback failed to start: ${String(e)}`));

    try {
      this.#decoder = this.#createDecoder({
        codec: info.codec,
        sampleRate: info.sampleRate,
        numberOfChannels: info.channels,
        output: (data) => this.#onDecoded(data),
        error: (e) => this.#fail(`audio decode failed: ${e.message}`),
      });
    } catch (e) {
      this.#fail(`audio decoder unavailable: ${String(e)}`);
    }
  }

  push(packet: WireAudioPacket): void {
    if (this.#failed || !this.#decoder) return;
    // scrcpy's Opus output has no confirmed use of a non-empty configuration
    // packet (tango-api notes this is unconfirmed either way); since it
    // carries no PCM there is nothing to decode regardless.
    if (packet.type === "configuration") return;
    try {
      this.#decoder.decode({ timestamp: packet.pts ?? 0, data: packet.data });
    } catch (e) {
      this.#fail(`audio decode failed: ${String(e)}`);
    }
  }

  end(): void {
    this.#teardown();
  }

  /** Estimated duration of audio handed to the player that real-time playback has not yet reached. Exposed for tests and any future latency display. */
  bufferedMs(): number {
    if (this.#playStartMs === null) return 0;
    return Math.max(0, this.#firedMs - (this.#now() - this.#playStartMs));
  }

  #onDecoded(data: DecodedAudioLike): void {
    if (this.#failed) {
      data.close();
      return;
    }
    const durationMs = (data.numberOfFrames / data.sampleRate) * 1000;
    const planes: Float32Array[] = [];
    for (let channel = 0; channel < data.numberOfChannels; channel++) {
      const plane = new Float32Array(data.numberOfFrames);
      data.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
      planes.push(plane);
    }
    data.close();

    const now = this.#now();
    if (this.#playStartMs === null) this.#playStartMs = now;
    const elapsed = now - this.#playStartMs;
    const prospective = Math.max(0, this.#firedMs - elapsed) + durationMs;
    // Samples already handed to the player cannot be un-queued; the only
    // lever against runaway latency is to stop counting the stale backlog,
    // resyncing to the target instead of letting it climb further.
    this.#firedMs = prospective > MAX_BUFFER_MS ? elapsed + TARGET_LATENCY_MS : this.#firedMs + durationMs;

    this.#player?.feed(planes);
  }

  #fail(message: string): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#onError(message);
    this.#teardown();
  }

  #teardown(): void {
    try {
      this.#decoder?.close();
    } catch {
      // already closed or errored; nothing left to tear down
    }
    this.#decoder = null;
    try {
      this.#player?.stop();
    } catch {
      // already stopped or errored
    }
    this.#player = null;
    this.#playStartMs = null;
    this.#firedMs = 0;
  }
}
