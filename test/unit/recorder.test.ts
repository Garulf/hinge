import { expect, test } from "vitest";
import { teeToRecording } from "../../src/main/recorder";
import { createQueuedWriter, type WritableLike } from "../../src/main/queued-writer";
import { decodeRecording, RECORDING_MAGIC } from "../../src/shared/recording";
import type { MediaSink } from "../../src/main/media-source";
import type { PostureReading } from "../../src/shared/posture";
import type { SessionStatus } from "../../src/shared/wire";

function fakeStream(): WritableLike & { chunks: Uint8Array[]; error: (e: Error) => void } {
  const chunks: Uint8Array[] = [];
  let errorListener: ((e: Error) => void) | null = null;
  return {
    chunks,
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    once(event, listener) {
      if (event === "error") errorListener = listener as (e: Error) => void;
    },
    error(e) {
      errorListener?.(e);
    },
  };
}

function decodeChunks(chunks: Uint8Array[]) {
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return decodeRecording(all);
}

test("writes the magic once, then every video and posture event with relative time", () => {
  const stream = fakeStream();
  const writer = createQueuedWriter(stream);
  let t = 1000;
  const inner: MediaSink = { videoStart() {}, videoPacket() {}, videoEnd() {}, status() {}, postureLine() {} };
  const sink = teeToRecording(inner, writer, () => t);
  sink.videoStart({ codecId: 1, width: 2, height: 3, deviceName: null });
  t = 1040;
  sink.videoPacket({ type: "data", keyframe: true, pts: 5, data: new Uint8Array([7]) });
  sink.postureLine!("OPENED");

  expect(Array.from(stream.chunks[0].subarray(0, RECORDING_MAGIC.length))).toEqual(Array.from(RECORDING_MAGIC));
  expect(decodeChunks(stream.chunks).map((e) => [e.t, e.kind])).toEqual([[0, "video-start"], [40, "video-packet"], [40, "posture-line"]]);
});

test("a stream error posts a sticky error status once, logs it, and drops further recording writes while mirroring keeps calling the inner sink", () => {
  const stream = fakeStream();
  const writer = createQueuedWriter(stream);
  const statuses: SessionStatus[] = [];
  const videoPackets: unknown[] = [];
  const logs: string[] = [];
  const inner: MediaSink = {
    videoStart() {},
    videoPacket: (p) => videoPackets.push(p),
    videoEnd() {},
    status: (s) => statuses.push(s),
    postureLine() {},
  };
  const sink = teeToRecording(inner, writer, () => 0, (l) => logs.push(l));

  sink.videoStart({ codecId: 1, width: 2, height: 3, deviceName: null });
  const chunksBeforeError = stream.chunks.length;
  stream.error(new Error("ENOSPC"));

  expect(statuses).toEqual([{ state: "error", message: "Recording failed: Error: ENOSPC" }]);
  expect(logs).toEqual(["Recording failed: Error: ENOSPC"]);

  // A later status from the live session must not overwrite the sticky one.
  sink.status({ state: "streaming", serial: "S1", model: null });
  expect(statuses).toEqual([
    { state: "error", message: "Recording failed: Error: ENOSPC" },
    { state: "error", message: "Recording failed: Error: ENOSPC" },
  ]);

  // Mirroring continues: video still reaches the inner sink.
  sink.videoPacket({ type: "data", keyframe: true, pts: 1, data: new Uint8Array([9]) });
  expect(videoPackets).toHaveLength(1);

  // No further bytes are written to the recording stream after the error.
  sink.videoPacket({ type: "data", keyframe: false, pts: 2, data: new Uint8Array([9]) });
  expect(stream.chunks.length).toBe(chunksBeforeError);
});

test("forwards posture readings to the inner sink without recording them (only the raw postureLine text is persisted)", () => {
  const stream = fakeStream();
  const writer = createQueuedWriter(stream);
  const postures: PostureReading[] = [];
  const inner: MediaSink = {
    videoStart() {},
    videoPacket() {},
    videoEnd() {},
    status() {},
    postureLine() {},
    posture: (r) => postures.push(r),
  };
  const sink = teeToRecording(inner, writer, () => 0);
  const reading: PostureReading = { stateId: 3, posture: "open", rotation: 0 };
  sink.posture!(reading);

  expect(postures).toEqual([reading]);
  expect(stream.chunks).toEqual([]);
});
