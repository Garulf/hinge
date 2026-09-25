import { expect, test } from "vitest";
import { teeToRecording } from "../../src/main/recorder";
import { decodeRecording, RECORDING_MAGIC } from "../../src/shared/recording";
import type { MediaSink } from "../../src/main/media-source";

test("writes the magic once, then every video and posture event with relative time", () => {
  const chunks: Uint8Array[] = [];
  let t = 1000;
  const inner: MediaSink = { videoStart() {}, videoPacket() {}, videoEnd() {}, status() {}, postureLine() {} };
  const sink = teeToRecording(inner, (c) => chunks.push(c), () => t);
  sink.videoStart({ codecId: 1, width: 2, height: 3, deviceName: null });
  t = 1040;
  sink.videoPacket({ type: "data", keyframe: true, pts: 5, data: new Uint8Array([7]) });
  sink.postureLine!("OPENED");
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  expect(Array.from(all.subarray(0, RECORDING_MAGIC.length))).toEqual(Array.from(RECORDING_MAGIC));
  expect(decodeRecording(all).map((e) => [e.t, e.kind])).toEqual([[0, "video-start"], [40, "video-packet"], [40, "posture-line"]]);
});
