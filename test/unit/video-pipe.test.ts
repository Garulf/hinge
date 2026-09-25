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

/** Mimics PhoneScene/FrameLifecycle's frame ownership (findings I3): closes
 * the current frame only when end() is called, not as soon as a new one
 * arrives (that part is exercised in frame-lifecycle.test.ts already). */
function fakeSceneTarget() {
  const frames: { closed: boolean }[] = [];
  let current: { closed: boolean; close(): void } | null = null;
  return {
    disposed: false,
    frames,
    setFrame: (f: { closed: boolean; close(): void }) => {
      current = f;
      frames.push(f);
    },
    end: () => {
      current?.close();
      current = null;
    },
  };
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
  const target = fakeSceneTarget();
  const onSize = vi.fn();
  const pipe = new VideoPipe(target as never, onSize, { createDecoder: trackingDecoderFactory(disposeLog) });

  pipe.start(info);
  pipe.push(dataPacket());
  await flush();

  expect(target.frames).toHaveLength(1);
  const firstFrame = target.frames[0];
  expect(firstFrame.closed).toBe(false);

  pipe.start(info);
  await flush();

  expect(disposeLog).toHaveLength(1);
  expect(firstFrame.closed).toBe(true);
});

test("start() always asks for hardwareAcceleration no-preference (I2 ruling: no custom fallback)", () => {
  const calls: string[] = [];
  const factory: DecoderFactory = (opts) => {
    calls.push(opts.hardwareAcceleration);
    return { writable: new WritableStream<ScrcpyVideoStreamPacket>(), sizeChanged: () => () => {}, framesDecoded: 0 };
  };
  const pipe = new VideoPipe(fakeSceneTarget() as never, () => {}, { createDecoder: factory });

  pipe.start(info);

  expect(calls).toEqual(["no-preference"]);
});

test("a genuine decode failure is reported through onError", async () => {
  const onError = vi.fn();
  const factory: DecoderFactory = () => ({
    writable: new WritableStream<ScrcpyVideoStreamPacket>({
      write: () => {
        throw new Error("no decoder available");
      },
    }),
    sizeChanged: () => () => {},
    framesDecoded: 0,
  });
  const pipe = new VideoPipe(fakeSceneTarget() as never, () => {}, { createDecoder: factory, onError });

  pipe.start(info);
  pipe.push(dataPacket());
  await flush();

  expect(onError).toHaveBeenCalledWith("no decoder available");
});

test("a stale pipe's error after a later start() does not call onError", async () => {
  const onError = vi.fn();
  let created = 0;
  const factory: DecoderFactory = () => {
    created += 1;
    const failsOnWrite = created === 1;
    return {
      writable: new WritableStream<ScrcpyVideoStreamPacket>({
        write: () => {
          if (failsOnWrite) throw new Error("boom from the superseded pipe");
        },
      }),
      sizeChanged: () => () => {},
      framesDecoded: 0,
    };
  };
  const pipe = new VideoPipe(fakeSceneTarget() as never, () => {}, { createDecoder: factory, onError });

  pipe.start(info);
  pipe.push(dataPacket());
  // Supersede the first pipe before its async rejection has a chance to run.
  pipe.start(info);
  await flush();

  expect(onError).not.toHaveBeenCalled();
});

function sizedFrame(width: number, height: number) {
  const f = { displayWidth: width, displayHeight: height, closed: false, close() { f.closed = true; } };
  return f as unknown as VideoFrame;
}

/** A decoder whose size and output frames the test drives by hand. */
function manualDecoderFactory() {
  const handles: { setSize(w: number, h: number): void; emit(frame: VideoFrame): Promise<void> }[] = [];
  const factory: DecoderFactory = (opts) => {
    const writer = opts.renderer.writable.getWriter();
    let listener: ((size: { width: number; height: number }) => void) | null = null;
    handles.push({
      setSize: (width, height) => listener?.({ width, height }),
      emit: (frame) => writer.write(frame),
    });
    return {
      writable: new WritableStream<ScrcpyVideoStreamPacket>(),
      sizeChanged: (fn) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
      framesDecoded: 0,
    };
  };
  return { factory, handles };
}

test("onFirstFrame fires once per size, only for a frame of the new size", async () => {
  const { factory, handles } = manualDecoderFactory();
  const onFirstFrame = vi.fn();
  const pipe = new VideoPipe(fakeSceneTarget() as never, () => {}, { createDecoder: factory, onFirstFrame });

  pipe.start({ ...info, width: 1080, height: 2520 });
  const decoder = handles[0];
  await decoder.emit(sizedFrame(1080, 2520));
  await decoder.emit(sizedFrame(1080, 2520));
  expect(onFirstFrame.mock.calls).toEqual([[1080, 2520]]);

  decoder.setSize(1968, 2184);
  // A frame the decoder had already queued at the old size is not the new stream's first.
  await decoder.emit(sizedFrame(1080, 2520));
  expect(onFirstFrame).toHaveBeenCalledTimes(1);
  await decoder.emit(sizedFrame(1968, 2184));
  await decoder.emit(sizedFrame(1968, 2184));
  expect(onFirstFrame.mock.calls).toEqual([[1080, 2520], [1968, 2184]]);
});

test("after a decode failure the pipe drops packets until a configuration arrives, then decodes on a fresh decoder", async () => {
  const onError = vi.fn();
  const written: ScrcpyVideoStreamPacket[][] = [];
  const factory: DecoderFactory = () => {
    const log: ScrcpyVideoStreamPacket[] = [];
    const index = written.push(log) - 1;
    return {
      writable: new WritableStream<ScrcpyVideoStreamPacket>({
        write: (packet) => {
          if (index === 0) throw new Error("decoder died");
          log.push(packet);
        },
      }),
      sizeChanged: () => () => {},
      framesDecoded: 0,
    };
  };
  const pipe = new VideoPipe(fakeSceneTarget() as never, () => {}, { createDecoder: factory, onError });

  pipe.start(info);
  pipe.push(dataPacket());
  await flush();
  expect(onError).toHaveBeenCalledOnce();

  pipe.push(dataPacket());
  expect(written).toHaveLength(1);

  pipe.push({ type: "configuration", data: new Uint8Array([9]) });
  pipe.push(dataPacket());
  await flush();

  expect(written).toHaveLength(2);
  expect(written[1].map((p) => p.type)).toEqual(["configuration", "data"]);
  expect(onError).toHaveBeenCalledOnce();
});
