import type { ScrcpyMediaStreamDataPacket, ScrcpyVideoCodecId, ScrcpyVideoStreamPacket } from "@yume-chan/scrcpy";
import { WebCodecsVideoDecoder } from "@yume-chan/scrcpy-decoder-webcodecs";
import { ReadableStream, type ReadableStreamDefaultController, type WritableStream } from "@yume-chan/stream-extra";
import type { VideoStreamInfo, WireMediaPacket } from "../shared/wire";
import type { FrameTarget } from "./texture-renderer";
import { TextureFrameRenderer } from "./texture-renderer";

type SizeChangedListener = (size: { width: number; height: number }) => void;

interface DecoderHandle {
  readonly writable: WritableStream<ScrcpyVideoStreamPacket>;
  readonly sizeChanged: (listener: SizeChangedListener) => () => void;
  readonly framesDecoded: number;
  dispose?(): unknown;
}

export type DecoderFactory = (options: {
  codec: number;
  renderer: TextureFrameRenderer;
  hardwareAcceleration: "no-preference";
  optimizeForLatency: boolean;
}) => DecoderHandle;

function defaultDecoderFactory(options: {
  codec: number;
  renderer: TextureFrameRenderer;
  hardwareAcceleration: "no-preference";
  optimizeForLatency: boolean;
}): DecoderHandle {
  return new WebCodecsVideoDecoder({ ...options, codec: options.codec as ScrcpyVideoCodecId });
}

function reconstruct(packet: WireMediaPacket): ScrcpyVideoStreamPacket {
  if (packet.type !== "data") return packet;
  const data: ScrcpyMediaStreamDataPacket = { type: "data", data: packet.data };
  if (packet.keyframe !== null) data.keyframe = packet.keyframe;
  if (packet.pts !== null) data.pts = BigInt(packet.pts);
  return data;
}

const SAME_ASPECT_TOLERANCE = 0.02;

function frameHasSize(frame: VideoFrame, size: { width: number; height: number }): boolean {
  const { displayWidth, displayHeight } = frame as Partial<VideoFrame>;
  if (!displayWidth || !displayHeight || !size.width || !size.height) return true;
  const expected = size.width / size.height;
  return Math.abs(displayWidth / displayHeight - expected) / expected < SAME_ASPECT_TOLERANCE;
}

export interface VideoPipeDeps {
  createDecoder?: DecoderFactory;
  onError?: (message: string) => void;
  /** The first decoded frame at each new stream size, after start() or a size change. */
  onFirstFrame?: (w: number, h: number) => void;
}

export class VideoPipe {
  readonly #target: FrameTarget;
  readonly #frames: FrameTarget;
  readonly #onSize: (w: number, h: number) => void;
  readonly #createDecoder: DecoderFactory;
  readonly #onError: (message: string) => void;
  readonly #onFirstFrame: (w: number, h: number) => void;
  #awaitingFirstFrame = false;
  #awaitingConfiguration = false;

  #info: VideoStreamInfo | null = null;
  #controller: ReadableStreamDefaultController<ScrcpyVideoStreamPacket> | null = null;
  #decoder: DecoderHandle | null = null;
  #unsubscribeSize: (() => void) | null = null;
  #lastSize = { width: 0, height: 0 };
  // Invalidates a pipeTo() rejection handler from a decoder that has since
  // been torn down by a later start()/end(), so a stale async error can't
  // clobber the status overlay for the stream that replaced it.
  #generation = 0;

  constructor(target: FrameTarget, onSize: (w: number, h: number) => void, deps?: VideoPipeDeps) {
    this.#target = target;
    this.#onSize = onSize;
    this.#createDecoder = deps?.createDecoder ?? defaultDecoderFactory;
    this.#onError = deps?.onError ?? (() => {});
    this.#onFirstFrame = deps?.onFirstFrame ?? (() => {});
    this.#frames = {
      get disposed() {
        return target.disposed;
      },
      setFrame: (frame) => this.#deliver(frame),
      end: () => target.end(),
    };
  }

  start(info: VideoStreamInfo): void {
    this.#teardown();
    this.#info = info;
    this.#sizeChanged({ width: info.width, height: info.height });
    this.#openStream();
  }

  push(packet: WireMediaPacket): void {
    if (this.#awaitingConfiguration) {
      // A fresh decoder rejects anything before its configuration, so the
      // packets still in flight from before a reset-video are dropped.
      if (packet.type !== "configuration") return;
      this.#awaitingConfiguration = false;
      this.#openStream();
    }
    try {
      this.#controller?.enqueue(reconstruct(packet));
    } catch {
      // the decoder pipe failed and cancelled this stream; its error handler takes over
    }
  }

  end(): void {
    this.#teardown();
    this.#info = null;
  }

  stats(): { framesDecoded: number; width: number; height: number } {
    return { framesDecoded: this.#decoder?.framesDecoded ?? 0, width: this.#lastSize.width, height: this.#lastSize.height };
  }

  #openStream(): void {
    const info = this.#info;
    if (!info) return;
    const generation = this.#generation;
    const readable = new ReadableStream<ScrcpyVideoStreamPacket>({
      start: (controller) => {
        this.#controller = controller;
      },
    });
    const decoder = this.#createDecoder({
      codec: info.codecId,
      renderer: new TextureFrameRenderer(this.#frames),
      hardwareAcceleration: "no-preference",
      optimizeForLatency: true,
    });
    this.#decoder = decoder;
    this.#unsubscribeSize = decoder.sizeChanged((e) => this.#sizeChanged(e));
    readable.pipeTo(decoder.writable).catch((e: unknown) => {
      if (generation !== this.#generation) return;
      console.error("video decode pipe failed", e);
      this.#teardown();
      this.#awaitingConfiguration = true;
      this.#onError(e instanceof Error ? e.message : String(e));
    });
  }

  #sizeChanged(size: { width: number; height: number }): void {
    this.#lastSize = size;
    this.#awaitingFirstFrame = true;
    this.#onSize(size.width, size.height);
  }

  #deliver(frame: VideoFrame): void {
    const first = this.#awaitingFirstFrame && frameHasSize(frame, this.#lastSize);
    this.#target.setFrame(frame);
    if (first) {
      this.#awaitingFirstFrame = false;
      this.#onFirstFrame(this.#lastSize.width, this.#lastSize.height);
    }
  }

  #teardown(): void {
    this.#generation++;
    this.#awaitingConfiguration = false;
    try {
      this.#controller?.close();
    } catch {
      // already closed or errored; nothing left to tear down
    }
    this.#controller = null;
    this.#disposeDecoder();
  }

  #disposeDecoder(): void {
    this.#unsubscribeSize?.();
    this.#unsubscribeSize = null;
    try {
      this.#decoder?.dispose?.();
    } catch {
      // the underlying transform stream may already be fully terminated
      // (e.g. the decoder's own pipe finished tearing itself down first)
    }
    this.#decoder = null;
  }
}
