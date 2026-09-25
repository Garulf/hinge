import type { ScrcpyMediaStreamDataPacket, ScrcpyVideoCodecId, ScrcpyVideoStreamPacket } from "@yume-chan/scrcpy";
import { WebCodecsVideoDecoder } from "@yume-chan/scrcpy-decoder-webcodecs";
import { ReadableStream, type ReadableStreamDefaultController, type WritableStream } from "@yume-chan/stream-extra";
import type { VideoStreamInfo, WireMediaPacket } from "../shared/wire";
import type { FrameTarget } from "./texture-renderer";
import { TextureFrameRenderer } from "./texture-renderer";

type HardwarePreference = "prefer-hardware" | "prefer-software";
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
  hardwareAcceleration: HardwarePreference;
  optimizeForLatency: boolean;
}) => DecoderHandle;

function defaultDecoderFactory(options: {
  codec: number;
  renderer: TextureFrameRenderer;
  hardwareAcceleration: HardwarePreference;
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

  #info: VideoStreamInfo | null = null;
  #controller: ReadableStreamDefaultController<ScrcpyVideoStreamPacket> | null = null;
  #decoder: DecoderHandle | null = null;
  #unsubscribeSize: (() => void) | null = null;
  #lastSize = { width: 0, height: 0 };
  #fellBackToSoftware = false;
  #waitingForConfig = false;

  constructor(target: FrameTarget, onSize: (w: number, h: number) => void, deps?: { createDecoder?: DecoderFactory }) {
    this.#target = target;
    this.#onSize = onSize;
    this.#createDecoder = deps?.createDecoder ?? defaultDecoderFactory;
  }

  start(info: VideoStreamInfo): void {
    this.#teardown();
    this.#info = info;
    this.#fellBackToSoftware = false;
    this.#waitingForConfig = false;
    this.#lastSize = { width: info.width, height: info.height };
    this.#onSize(info.width, info.height);
    this.#openStream("prefer-hardware");
  }

  push(packet: WireMediaPacket): void {
    // After the decoder is recreated mid-stream (software fallback), the
    // codec transform throws on a data chunk that arrives before its own
    // configuration chunk; drop such chunks instead of killing the pipe.
    if (this.#waitingForConfig && packet.type === "data") return;
    if (packet.type === "configuration") this.#waitingForConfig = false;
    this.#controller?.enqueue(reconstruct(packet));
  }

  end(): void {
    this.#teardown();
    this.#info = null;
  }

  stats(): { framesDecoded: number; width: number; height: number } {
    return { framesDecoded: this.#decoder?.framesDecoded ?? 0, width: this.#lastSize.width, height: this.#lastSize.height };
  }

  #openStream(hardwareAcceleration: HardwarePreference): void {
    const info = this.#info;
    if (!info) return;
    const readable = new ReadableStream<ScrcpyVideoStreamPacket>({
      start: (controller) => {
        this.#controller = controller;
      },
    });
    const decoder = this.#createDecoder({
      codec: info.codecId,
      renderer: new TextureFrameRenderer(this.#target),
      hardwareAcceleration,
      optimizeForLatency: true,
    });
    this.#decoder = decoder;
    this.#unsubscribeSize = decoder.sizeChanged((e) => {
      this.#lastSize = { width: e.width, height: e.height };
      this.#onSize(e.width, e.height);
    });
    readable.pipeTo(decoder.writable).catch((e: unknown) => this.#onPipeError(e, hardwareAcceleration));
  }

  #onPipeError(e: unknown, previousMode: HardwarePreference): void {
    if (!(e instanceof DOMException) || this.#fellBackToSoftware || previousMode === "prefer-software") {
      console.error("video decode pipe stopped", e);
      return;
    }
    this.#fellBackToSoftware = true;
    this.#waitingForConfig = true;
    this.#disposeDecoder();
    this.#openStream("prefer-software");
  }

  #teardown(): void {
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
