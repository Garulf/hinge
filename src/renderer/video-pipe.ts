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

export class VideoPipe {
  readonly #target: FrameTarget;
  readonly #onSize: (w: number, h: number) => void;
  readonly #createDecoder: DecoderFactory;
  readonly #onError: (message: string) => void;

  #info: VideoStreamInfo | null = null;
  #controller: ReadableStreamDefaultController<ScrcpyVideoStreamPacket> | null = null;
  #decoder: DecoderHandle | null = null;
  #unsubscribeSize: (() => void) | null = null;
  #lastSize = { width: 0, height: 0 };
  // Invalidates a pipeTo() rejection handler from a decoder that has since
  // been torn down by a later start()/end(), so a stale async error can't
  // clobber the status overlay for the stream that replaced it.
  #generation = 0;

  constructor(target: FrameTarget, onSize: (w: number, h: number) => void, deps?: { createDecoder?: DecoderFactory; onError?: (message: string) => void }) {
    this.#target = target;
    this.#onSize = onSize;
    this.#createDecoder = deps?.createDecoder ?? defaultDecoderFactory;
    this.#onError = deps?.onError ?? (() => {});
  }

  start(info: VideoStreamInfo): void {
    this.#teardown();
    this.#info = info;
    this.#lastSize = { width: info.width, height: info.height };
    this.#onSize(info.width, info.height);
    this.#openStream();
  }

  push(packet: WireMediaPacket): void {
    this.#controller?.enqueue(reconstruct(packet));
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
      renderer: new TextureFrameRenderer(this.#target),
      hardwareAcceleration: "no-preference",
      optimizeForLatency: true,
    });
    this.#decoder = decoder;
    this.#unsubscribeSize = decoder.sizeChanged((e) => {
      this.#lastSize = { width: e.width, height: e.height };
      this.#onSize(e.width, e.height);
    });
    readable.pipeTo(decoder.writable).catch((e: unknown) => {
      if (generation !== this.#generation) return;
      console.error("video decode pipe failed", e);
      this.#onError(e instanceof Error ? e.message : String(e));
    });
  }

  #teardown(): void {
    this.#generation++;
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
