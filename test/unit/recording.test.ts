import { expect, test } from "vitest";
import { decodeRecording, encodeEvent, RECORDING_MAGIC, type RecordedEvent } from "../../src/shared/recording";

test("round trips every event kind", () => {
  const events: RecordedEvent[] = [
    { t: 0, kind: "video-start", info: { codecId: 0x68323634, width: 1080, height: 2520, deviceName: "SM-F966B" } },
    { t: 5, kind: "video-packet", packet: { type: "session", width: 1080, height: 2520, isClientResize: false } },
    { t: 6, kind: "video-packet", packet: { type: "configuration", data: new Uint8Array([0, 0, 0, 1, 0x67]) } },
    { t: 7, kind: "video-packet", packet: { type: "data", keyframe: true, pts: 1000, data: new Uint8Array([9, 9]) } },
    { t: 8, kind: "posture-line", line: "Committed state: DeviceState{identifier=3, name='OPENED'}" },
  ];
  const bytes = concat([RECORDING_MAGIC, ...events.map(encodeEvent)]);
  expect(decodeRecording(bytes)).toEqual(events);
});

test("rejects a file without the magic header", () => {
  expect(() => decodeRecording(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow(/not a hinge recording/);
});

test("a truncated final record is dropped, earlier records survive", () => {
  const ok = encodeEvent({ t: 1, kind: "posture-line", line: "a" });
  const cut = encodeEvent({ t: 2, kind: "posture-line", line: "bbbb" }).subarray(0, 6);
  expect(decodeRecording(concat([RECORDING_MAGIC, ok, cut]))).toHaveLength(1);
});

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
