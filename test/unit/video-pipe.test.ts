import type { ScrcpyVideoStreamPacket } from "@yume-chan/scrcpy";
import { WritableStream } from "@yume-chan/stream-extra";
import { expect, test, vi } from "vitest";
import { VideoPipe, type DecoderFactory } from "../../src/renderer/video-pipe";
import type { VideoStreamInfo, WireMediaPacket } from "../../src/shared/wire";

const info: VideoStreamInfo = { codecId: 0, width: 100, height: 200, deviceName: null };

function fakeFrame() {
  const f = { closed: false, close() { f.closed = true; } };
  return f as unknown as VideoFrame;
}

function dataPacket(): WireMediaPacket {
  return { type: "data", keyframe: true, pts: 1, data: new Uint8Array([1]) };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Forwards manufactured VideoFrames into the real TextureFrameRenderer so
 * frame-closing behaviour can be observed without a real VideoDecoder.
 */
function trackingDecoderFactory(disposeLog: unknown[]) {
  let framesDecoded = 0;
  const factory: DecoderFactory = (opts) => {
    const writer = opts.renderer.writable.getWriter();
    const decoder = {
      writable: new WritableStream<ScrcpyVideoStreamPacket>({
        write: (packet) => {
          if (packet.type === "data") {
            framesDecoded += 1;
            return writer.write(fakeFrame());
          }
          return undefined;
        },
        close: () => writer.close(),
      }),
      sizeChanged: () => () => {},
      get framesDecoded() {
        return framesDecoded;
      },
      dispose: () => disposeLog.push(opts),
    };
    return decoder;
  };
  return factory;
}

test("a second video-start tears down the previous decoder and closes its held frame", async () => {
  const disposeLog: unknown[] = [];
  const frames: unknown[] = [];
  const target = { disposed: false, setFrame: (f: unknown) => frames.push(f) };
  const onSize = vi.fn();
  const pipe = new VideoPipe(target as never, onSize, { createDecoder: trackingDecoderFactory(disposeLog) });

  pipe.start(info);
  pipe.push(dataPacket());
  await flush();

  expect(frames).toHaveLength(1);
  const firstFrame = frames[0] as { closed: boolean };
  expect(firstFrame.closed).toBe(false);

  pipe.start(info);
  await flush();

  expect(disposeLog).toHaveLength(1);
  expect(firstFrame.closed).toBe(true);
});

test("a DOMException from the decoder triggers one software fallback", async () => {
  const calls: string[] = [];
  const target = { disposed: false, setFrame: () => {} };
  const factory: DecoderFactory = (opts) => {
    calls.push(opts.hardwareAcceleration);
    const shouldFail = opts.hardwareAcceleration === "prefer-hardware";
    return {
      writable: new WritableStream<ScrcpyVideoStreamPacket>({
        write: () => {
          if (shouldFail) throw new DOMException("no hardware decoder", "NotSupportedError");
        },
      }),
      sizeChanged: () => () => {},
      framesDecoded: 0,
      dispose: () => {},
    };
  };
  const pipe = new VideoPipe(target as never, () => {}, { createDecoder: factory });

  pipe.start(info);
  pipe.push(dataPacket());
  await flush();

  expect(calls).toEqual(["prefer-hardware", "prefer-software"]);
});
