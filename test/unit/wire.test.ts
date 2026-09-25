import { expect, test } from "vitest";
import { toWire, toWireAudio, transferablesOf } from "../../src/shared/wire";

test("data packet pts becomes a number and missing fields become null", () => {
  const data = new Uint8Array([1, 2, 3]);
  expect(toWire({ type: "data", pts: 123456789n, keyframe: true, data })).toEqual({ type: "data", pts: 123456789, keyframe: true, data });
  expect(toWire({ type: "data", data })).toEqual({ type: "data", pts: null, keyframe: null, data });
});

test("packet data is copied into an owned buffer so it can be transferred", () => {
  const pool = new Uint8Array(100);
  const view = pool.subarray(10, 20);
  const wire = toWire({ type: "configuration", data: view });
  if (wire.type !== "configuration") throw new Error("type");
  expect(wire.data.byteOffset).toBe(0);
  expect(wire.data.buffer.byteLength).toBe(10);
  expect(transferablesOf({ kind: "video-packet", packet: wire })).toEqual([wire.data.buffer]);
});

test("session packets and non-packet messages carry no transferables", () => {
  expect(transferablesOf({ kind: "video-packet", packet: { type: "session", width: 1, height: 2, isClientResize: false } })).toEqual([]);
  expect(transferablesOf({ kind: "video-end" })).toEqual([]);
  expect(transferablesOf({ kind: "posture", reading: { stateId: 3, posture: "open", rotation: 0 } })).toEqual([]);
});

test("audio data packet pts becomes a number and a missing pts becomes null", () => {
  const data = new Uint8Array([4, 5, 6]);
  expect(toWireAudio({ type: "data", pts: 42n, data })).toEqual({ type: "data", pts: 42, data });
  expect(toWireAudio({ type: "data", data })).toEqual({ type: "data", pts: null, data });
});

test("audio packet data is copied into an owned buffer, and audio-packet carries it as a transferable", () => {
  const pool = new Uint8Array(50);
  const view = pool.subarray(5, 15);
  const wire = toWireAudio({ type: "configuration", data: view });
  expect(wire.data.byteOffset).toBe(0);
  expect(wire.data.buffer.byteLength).toBe(10);
  expect(transferablesOf({ kind: "audio-packet", packet: wire })).toEqual([wire.data.buffer]);
});

test("audio-start and audio-end carry no transferables", () => {
  expect(transferablesOf({ kind: "audio-start", info: { codec: "opus", sampleRate: 48000, channels: 2 } })).toEqual([]);
  expect(transferablesOf({ kind: "audio-end" })).toEqual([]);
  expect(transferablesOf({ kind: "audio-end", reason: "unsupported" })).toEqual([]);
});
